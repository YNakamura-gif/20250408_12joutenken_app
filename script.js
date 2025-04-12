// ======================================================================
// 1. Firebase Configuration & Initialization
// ======================================================================
const firebaseConfig = {
  apiKey: "AIzaSyBLP1YSrdUd_LGu4xZ-jKf-_FPYljq226w",
  authDomain: "project-4814457387099311122.firebaseapp.com",
  databaseURL: "https://project-4814457387099311122-default-rtdb.firebaseio.com",
  projectId: "project-4814457387099311122",
  storageBucket: "project-4814457387099311122.firebasestorage.app",
  messagingSenderId: "1065188683035",
  appId: "1:1065188683035:web:0a2dce8ad18521bfba77be",
  measurementId: "G-S3H1YJQEPR"
};

firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// ======================================================================
// 2. Global State & Prediction Data Storage
// ======================================================================
let locationPredictions = [];
let degradationItemsData = []; // 新しい劣化項目データ用

let currentProjectId = null;
let currentBuildingId = null;
let buildings = {};
let lastUsedBuilding = null;
let deteriorationData = {};
let deteriorationListeners = {};
let currentEditRecordId = null;
let lastAddedLocation = '';
let lastAddedName = '';
let buildingsListener = null; // Firebase listener for buildings

// ======================================================================
// 3. Firebase Reference Getters
// ======================================================================
function getProjectBaseRef(projectId) {
  return database.ref(`projects/${projectId}`);
}
function getProjectInfoRef(projectId) {
  return database.ref(`projects/${projectId}/info`);
}
function getBuildingsRef(projectId) {
  return database.ref(`projects/${projectId}/buildings`);
}
function getDeteriorationsRef(projectId, buildingId) {
  return database.ref(`projects/${projectId}/deteriorations/${buildingId}`);
}
function getDeteriorationCounterRef(projectId, buildingId) {
  return database.ref(`projects/${projectId}/counters/${buildingId}`);
}

// ======================================================================
// 4. Utility Functions
// ======================================================================
function generateProjectId(siteName) {
    if (!siteName) return null;
    const safeSiteName = siteName.replace(/[.#$\[\]]/g, '_'); 
    return safeSiteName;
}

function generateBuildingId(buildingName) {
    if (!buildingName) return null;
    const safeBuildingName = buildingName.replace(/[.#$\[\]]/g, '_').substring(0, 50); 
    return safeBuildingName;
}

function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return unsafe;
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
 }

// ★ NEW: Katakana to Hiragana converter function
function katakanaToHiragana(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[ァ-ヶ]/g, match => {
    const chr = match.charCodeAt(0) - 0x60;
    return String.fromCharCode(chr);
  });
}

// ★ NEW: Full-width numbers to Half-width converter function
function zenkakuToHankaku(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[０-９]/g, function(s) {
    return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
  });
}

// ======================================================================
// 5. Data Loading/Parsing (CSV, Predictions)
// ======================================================================
function parseCsv(csvText, expectedColumns) {
  console.log("[parseCsv] Starting parse. Expected columns:", expectedColumns);
  console.log("[parseCsv] Received text (first 100 chars):", csvText.substring(0, 100)); // ★ 追加：受け取ったテキストの先頭を表示
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length <= 1) {
    console.warn("CSV file has no data or only a header.");
    return [];
  }
  const header = lines.shift().split(',');
  console.log("[parseCsv] Header:", header);
  if (header.length < expectedColumns) {
      console.warn(`CSV header has fewer columns (${header.length}) than expected (${expectedColumns}).`);
  }

  return lines.map((line, index) => { // ★ 追加：行番号もログ
    const values = line.split(',');
    console.log(`[parseCsv] Line ${index + 1} values:`, values); // ★ 追加：パースした各行の配列を表示
    if (expectedColumns === 3 && header[0] === '階数') { // ヘッダーで場所CSVかを判断
      const floor = values[0]?.trim() || ''; // 階数がない場合は空文字に
      const value = values[1]?.trim(); // 部屋名
      const reading = values[2]?.trim(); // 読み
      // 部屋名があれば有効なデータとする
      return value ? { floor: floor, value: value, reading: reading || '' } : null;
    }
    // ★ 劣化項目CSV (3列想定) の処理
    else if (expectedColumns === 3 && header[0] === '劣化名') { // ★ header[0]が劣化名の場合を追加
      const name = values[0]?.trim();
      const code = values[1]?.trim();
      const reading = values[2]?.trim();
      return name ? { name: name, code: code || '', reading: reading || '' } : null;
    } else {
      console.warn(`Unsupported expectedColumns or unknown CSV format: ${expectedColumns}, Header: ${header[0]}`);
      return null;
    }
  }).filter(item => item !== null);
}

async function fetchAndParseCsv(filePath, expectedColumns) { 
  console.log(`Fetching CSV from: ${filePath}`);
  try {
    const response = await fetch(filePath);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status} for ${filePath}`);
    }
    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder('utf-8');
    let text = decoder.decode(buffer);
    console.log(`[fetchAndParseCsv] Decoded text (first 200 chars) from ${filePath}:`, text.substring(0, 200)); // ★ 追加：デコード直後のテキストを表示
    console.log(`[fetchAndParseCsv] First char code: ${text.charCodeAt(0)} (BOM check: 65279 is BOM)`); // ★ 追加：BOM確認用ログ
    if (text.charCodeAt(0) === 0xFEFF) {
      console.log("[fetchAndParseCsv] BOM detected and removed."); // ★ 追加
      text = text.slice(1);
    }
    return parseCsv(text, expectedColumns); 
  } catch (error) {
    console.error(`Error fetching or parsing CSV ${filePath}:`, error);
    return [];
  }
}

async function loadPredictionData() {
  console.log("Loading prediction data...");
  try {
    // Promise.all を使って並列読み込み
    [locationPredictions, degradationItemsData] = await Promise.all([
      fetchAndParseCsv('./部屋名_読み付き.csv', 3),       // ★ 変更: 場所データは3列期待
      fetchAndParseCsv('./劣化項目_読み付き.csv', 3)     // 劣化項目データは3列期待
    ]);
    // 古い部位・劣化名のログを削除
    console.log(`Loaded ${locationPredictions.length} location predictions (Rooms with Floor).`);
    console.log(`Loaded ${degradationItemsData.length} degradation items (Name, Code, Reading).`);
    // degradationItemsData の内容を少し表示して確認 (デバッグ用)
    console.log("Sample degradationItemsData:", degradationItemsData.slice(0, 5)); 
  } catch (error) {
    console.error("Critical error loading prediction data:", error);
    alert("予測変換データの読み込みに失敗しました。アプリケーションが正しく動作しない可能性があります。");
  }
}

// ======================================================================
// 6. Prediction Logic Functions
// ======================================================================

// ★ COMBINED RESULTS generateLocationPredictions function
function generateLocationPredictions(inputText) {
  console.log(`[generateLocationPredictions] Input: \"${inputText}\"`);

  // ★ 1. Convert full-width numbers to half-width in the input
  const inputTextHankaku = zenkakuToHankaku(inputText.trim());
  console.log(`[generateLocationPredictions] Input after Hankaku conversion: \"${inputTextHankaku}\"`);

  let floorSearchTerm = null;
  let roomSearchTermRaw = inputTextHankaku;
  let roomSearchTermHiragana = '';

  // Regex to detect floor prefix (e.g., 1, B1, PH)
  const floorMatch = roomSearchTermRaw.match(/^([a-zA-Z0-9]{1,3})(.*)$/);

  if (floorMatch && floorMatch[1] && floorMatch[2]) {
    floorSearchTerm = floorMatch[1].toLowerCase();
    roomSearchTermRaw = floorMatch[2];
    console.log(`[generateLocationPredictions] Floor search term: '${floorSearchTerm}', Room search term raw: '${roomSearchTermRaw}'`);
  } else if (roomSearchTermRaw.match(/^[a-zA-Z0-9]{1,3}$/)) {
      floorSearchTerm = roomSearchTermRaw.toLowerCase();
      roomSearchTermRaw = '';
      console.log(`[generateLocationPredictions] Input is potentially floor only: '${floorSearchTerm}'`);
  } else {
    console.log("[generateLocationPredictions] No floor prefix detected in input.");
  }

  roomSearchTermHiragana = katakanaToHiragana(roomSearchTermRaw.toLowerCase());

  if (!roomSearchTermHiragana && !floorSearchTerm) {
      console.log("[generateLocationPredictions] No valid search term.");
      return [];
  }

  // ★ 2. Find matching floors from CSV
  let matchingFloors = [];
  const floorSet = new Set(); // Use Set to avoid duplicates
  if (floorSearchTerm !== null) {
    locationPredictions.forEach(item => {
      const itemFloorLower = item.floor?.toLowerCase() || '';
      if (itemFloorLower.startsWith(floorSearchTerm)) {
        floorSet.add(item.floor); // Add the original floor string (not lowercase)
      }
    });
    matchingFloors = Array.from(floorSet);
    console.log(`[generateLocationPredictions] Found ${matchingFloors.length} matching floors in CSV:`, matchingFloors);
  } else {
    // If no floor search term, we only search based on room name later.
    // We don't add [''] here anymore, as it complicates combination logic.
    console.log(`[generateLocationPredictions] No floor search term, will search by room name only.`);
  }

  // ★ 3. Find matching room names from CSV
  let matchingRoomNames = [];
  const roomNameSet = new Set(); // Use Set to avoid duplicates

  if (roomSearchTermHiragana) {
    // If a room name part is entered, find rooms matching the reading
    locationPredictions.forEach(item => {
      const itemReadingHiragana = katakanaToHiragana(item.reading?.toLowerCase() || '');
      if (itemReadingHiragana.startsWith(roomSearchTermHiragana)) {
        if (item.value) roomNameSet.add(item.value); // Add the room name if it exists
      }
    });
    matchingRoomNames = Array.from(roomNameSet);
    console.log(`[generateLocationPredictions] Found ${matchingRoomNames.length} matching room names based on reading:`, matchingRoomNames);

  } else if (floorSearchTerm !== null) {
    // <<<<< MODIFIED LOGIC >>>>>
    // If ONLY floor is entered, get ALL unique room names from the CSV
    console.log('[generateLocationPredictions] Floor term entered, collecting all unique room names.');
    locationPredictions.forEach(item => {
      if (item.value) { // Ensure room name exists
        roomNameSet.add(item.value);
      }
    });
    matchingRoomNames = Array.from(roomNameSet);
    console.log(`[generateLocationPredictions] Collected ${matchingRoomNames.length} unique room names from CSV.`);
    // <<<<< END MODIFIED LOGIC >>>>>

  } else {
    // No floor or room search term (should not happen due to check at the beginning)
    console.log('[generateLocationPredictions] No floor or room search term, no room name matches generated.');
  }

  // ★ 4. Generate all combinations
  let combinations = [];

  // Add matching floors themselves as candidates if no room name was specifically searched
  if (!roomSearchTermHiragana && floorSearchTerm) {
    matchingFloors.forEach(floor => {
        if (floor) { // Ensure floor is not empty
            combinations.push(floor);
        }
    });
  }

  // Generate floor + room name combinations
  for (const floor of matchingFloors) {
      if (!floor) continue; // Skip if floor is empty
      for (const roomName of matchingRoomNames) {
         if (!roomName) continue; // Skip if room name is empty
          // Only add combination if floor was part of the search OR room name was part of search
         if (floorSearchTerm || roomSearchTermHiragana) {
              combinations.push(`${floor} ${roomName}`);
         }
      }
  }

  // If only a room name was searched (no floor), ensure room names themselves are included
  if (!floorSearchTerm && roomSearchTermHiragana) {
       matchingRoomNames.forEach(room => {
           if (room) combinations.push(room);
       });
  }


  console.log(`[generateLocationPredictions] Generated ${combinations.length} raw combinations`);
  if (combinations.length > 0) console.log("[generateLocationPredictions] Raw combinations sample:", combinations.slice(0, 10));


  // Remove duplicates and limit
  const uniqueCombinations = [...new Set(combinations)];
  console.log(`[generateLocationPredictions] Final unique combinations count: ${uniqueCombinations.length}`);
  if (uniqueCombinations.length > 0) console.log("[generateLocationPredictions] Final unique combinations sample:", uniqueCombinations.slice(0, 10));


  // Return up to 10 combinations
  return uniqueCombinations.slice(0, 10);
}

function generateDeteriorationPredictions(inputText) {
  console.log(`[generateDeteriorationPredictions] Input: "${inputText}"`);
  // ★ 入力もひらがなに変換
  const searchTermHiragana = katakanaToHiragana(inputText.trim().toLowerCase());
  if (!searchTermHiragana) return [];

  console.log("[generateDeteriorationPredictions] Searching in degradationItemsData:", degradationItemsData.length, "items with term:", searchTermHiragana);

  let results = [];

  // 1. 読み仮名による前方一致検索 (ひらがなで比較)
  const readingMatches = degradationItemsData
    .filter(item => {
        // ★ CSV側の読み仮名もひらがなに変換して比較
        const readingHiragana = katakanaToHiragana(item.reading?.toLowerCase() || '');
        return readingHiragana.startsWith(searchTermHiragana);
    })
    .map(item => item.name);

  console.log(`[generateDeteriorationPredictions] Reading matches found: ${readingMatches.length}`); 
  if (readingMatches.length > 0) console.log("[generateDeteriorationPredictions] Reading matches sample:", readingMatches.slice(0, 5));
  results = results.concat(readingMatches);

  // 2. 2文字コードによる完全一致検索 (入力がちょうど2文字の場合)
  // ★ コード検索はそのまま (英数字想定)
  const searchTermCode = inputText.trim().toLowerCase(); // コード検索用は元の入力を使う
  if (searchTermCode.length === 2) { 
    const codeMatches = degradationItemsData
      .filter(item => {
          const codeLower = item.code?.toLowerCase();
          return codeLower && codeLower === searchTermCode;
        })
      .map(item => item.name); 
      
    console.log(`[generateDeteriorationPredictions] Code matches found for '${searchTermCode}': ${codeMatches.length}`); 
    if (codeMatches.length > 0) console.log("[generateDeteriorationPredictions] Code matches sample:", codeMatches.slice(0, 5));
    results = results.concat(codeMatches);
  }

  // 重複を除去して最大10件返す
  const uniqueResults = [...new Set(results)];
  console.log(`[generateDeteriorationPredictions] Total unique results before slice: ${uniqueResults.length}`);
  return uniqueResults.slice(0, 10);
}

function showPredictions(inputElement, predictionListElement, predictions) {
  predictionListElement.innerHTML = ''; // Clear previous predictions

  if (predictions.length > 0) {
    predictions.forEach(prediction => {
      const li = document.createElement('li');
      li.textContent = prediction;
      li.setAttribute('tabindex', '-1');
      li.classList.add('px-3', 'py-1', 'cursor-pointer', 'hover:bg-blue-100', 'list-none', 'text-sm');

      // Restore touchend event listener
      li.addEventListener('touchend', (e) => {
        e.preventDefault();
        inputElement.value = prediction;

        // ★ Restore simple hidePredictions call
        hidePredictions(predictionListElement);

        let nextFocusElement = null;
        if (inputElement.id === 'locationInput') {
          nextFocusElement = document.getElementById('deteriorationNameInput');
        } else if (inputElement.id === 'deteriorationNameInput') {
          nextFocusElement = document.getElementById('photoNumberInput');
        } else if (inputElement.id === 'editLocationInput') {
          nextFocusElement = document.getElementById('editDeteriorationNameInput');
        } else if (inputElement.id === 'editDeteriorationNameInput') {
          nextFocusElement = document.getElementById('editPhotoNumberInput');
        }

        if (nextFocusElement) {
          // ★ Restore focus/click attempt with timeout 0
          setTimeout(() => {
            nextFocusElement.focus();
            nextFocusElement.click();
          }, 0);
        }
      });
      predictionListElement.appendChild(li);
    });
    predictionListElement.classList.remove('hidden');
  } else {
    hidePredictions(predictionListElement);
  }
}

function hidePredictions(predictionListElement) {
  predictionListElement.classList.add('hidden');
}

function setupPredictionListeners(inputElement, predictionListElement, generatorFn, nextElementId) {
  if (!inputElement || !predictionListElement) {
      console.warn("setupPredictionListeners: Input or List element not found.");
      return;
  }

  inputElement.addEventListener('input', () => {
    const inputText = inputElement.value;
    if (inputText.trim()) {
        const predictions = generatorFn(inputText);
        showPredictions(inputElement, predictionListElement, predictions);
    } else {
        hidePredictions(predictionListElement);
    }
  });

  // Restore original blur listener
  inputElement.addEventListener('blur', () => {
    setTimeout(() => hidePredictions(predictionListElement), 200);
  });

  inputElement.addEventListener('focus', () => {
    const inputText = inputElement.value;
    if (inputText.trim()) {
      const predictions = generatorFn(inputText);
      if (predictions.length > 0) {
          showPredictions(inputElement, predictionListElement, predictions);
      }
    }
  });

  // ★★★ Enterキーでのフォーカス移動リスナーを追加 ★★★
  if (nextElementId) { // 次の要素のIDが指定されている場合のみ
    inputElement.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault(); // デフォルトのEnter動作（フォーム送信など）を抑制
        hidePredictions(predictionListElement); // 予測リストを隠す
        const nextElement = document.getElementById(nextElementId);
        if (nextElement) {
          nextElement.focus(); // 次の要素にフォーカス
        }
      }
    });
  }
  // ★★★ ここまで ★★★
}

// ======================================================================
// 7. UI Update Functions
// ======================================================================
function switchTab(activeTabId, infoTabBtn, detailTabBtn, infoTab, detailTab) {
  if (activeTabId === 'info') {
    infoTab.classList.remove('hidden');
    detailTab.classList.add('hidden');
    infoTabBtn.classList.add('bg-blue-600', 'text-white');
    infoTabBtn.classList.remove('bg-gray-200', 'text-gray-700');
    detailTabBtn.classList.add('bg-gray-200', 'text-gray-700');
    detailTabBtn.classList.remove('bg-blue-600', 'text-white');
  } else if (activeTabId === 'detail') {
    detailTab.classList.remove('hidden');
    infoTab.classList.add('hidden');
    detailTabBtn.classList.add('bg-blue-600', 'text-white');
    detailTabBtn.classList.remove('bg-gray-200', 'text-gray-700');
    infoTabBtn.classList.add('bg-gray-200', 'text-gray-700');
    infoTabBtn.classList.remove('bg-blue-600', 'text-white');
  }
}

async function updateNextIdDisplay(projectId, buildingId, nextIdDisplayElement) {
  if (!projectId || !buildingId) {
    nextIdDisplayElement.textContent = '1';
    return;
  }
  try {
    const snapshot = await getDeteriorationCounterRef(projectId, buildingId).once('value');
    const currentCounter = snapshot.val() || 0;
    nextIdDisplayElement.textContent = (currentCounter + 1).toString();
  } catch (error) {
    console.error("Error fetching counter for next ID display:", error);
    nextIdDisplayElement.textContent = '-'; 
  }
}

function renderDeteriorationTable(recordsToRender, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput) {
    if (!deteriorationTableBodyElement) return;
    deteriorationTableBodyElement.innerHTML = ''; // Clear existing rows

    if (recordsToRender.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5; // Span all columns
        td.textContent = '登録データがありません。';
        td.classList.add('text-center', 'py-4', 'text-gray-500');
        tr.appendChild(td);
        deteriorationTableBodyElement.appendChild(tr);
        return;
    }

    recordsToRender.forEach(record => {
        const tr = document.createElement('tr');
        tr.classList.add('border-b');
        tr.innerHTML = `
            <td class="py-0 px-2 text-center text-sm">${escapeHtml(record.number)}</td>
            <td class="py-0 px-2 text-sm">
                <div class="cell-truncate" title="${escapeHtml(record.location)}">
                    ${escapeHtml(record.location)}
                </div>
            </td>
            <td class="py-0 px-2 text-sm">
                <div class="cell-truncate" title="${escapeHtml(record.name)}">
                    ${escapeHtml(record.name)}
                </div>
            </td>
            <td class="py-0 px-2 text-center text-sm">${escapeHtml(record.photoNumber)}</td>
            <td class="py-0 px-1 text-center whitespace-nowrap">
                <button class="edit-btn bg-green-500 hover:bg-green-600 text-white py-1 px-2 rounded text-sm">編集</button>
                <button class="delete-btn bg-red-500 hover:bg-red-600 text-white py-1 px-2 rounded text-sm">削除</button>
            </td>
        `;
        // Add event listeners for edit and delete buttons
        const editBtn = tr.querySelector('.edit-btn');
        const deleteBtn = tr.querySelector('.delete-btn');
        if (editBtn) {
            editBtn.addEventListener('click', () => handleEditClick(currentProjectId, currentBuildingId, record.id, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput));
        }
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => handleDeleteClick(currentProjectId, currentBuildingId, record.id, record.number));
        }
        deteriorationTableBodyElement.appendChild(tr);
    });
}

// ======================================================================
// 8. Data Loading - Building List & Deteriorations
// ======================================================================
async function updateBuildingSelectorForProject(projectId, buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput) {
  if (!projectId) {
    console.warn("[updateBuildingSelectorForProject] No projectId provided.");
    buildingSelectElement.innerHTML = '<option value="">-- 現場を先に選択 --</option>';
    buildingSelectElement.disabled = true;
    buildings = {}; // Clear buildings cache
    return;
  }
  console.log(`[updateBuildingSelectorForProject] Updating building selector for project ID: ${projectId}`);

  buildingSelectElement.disabled = true;
  buildingSelectElement.innerHTML = '<option value="">読み込み中...</option>'; // Show loading state

  // Detach previous listener if exists for this project
  if (buildingsListener && buildingsListener.projectId === projectId) {
    console.log(`[updateBuildingSelectorForProject] Detaching existing listener for project ${projectId}`);
    buildingsListener.ref.off('value', buildingsListener.callback);
    buildingsListener = null;
  }

  const buildingsDataRef = getBuildingsRef(projectId);
  buildings = {}; // Reset buildings cache for the new project

  // Define the listener callback
  const listenerCallback = (snapshot) => {
    console.log(`[Building Listener] Data received for project ${projectId}`);
    buildings = snapshot.val() || {};
    buildingSelectElement.innerHTML = ''; // Clear current options
    const buildingEntries = Object.entries(buildings);

    if (buildingEntries.length === 0) {
      buildingSelectElement.innerHTML = '<option value="">-- 建物未登録 --</option>';
      buildingSelectElement.disabled = true;
      activeBuildingNameSpanElement.textContent = '未選択';
      currentBuildingId = null; // Ensure no building is selected
      localStorage.removeItem('lastBuildingId'); // Clear last building ID for this project
      updateNextIdDisplay(projectId, null, nextIdDisplayElement);
      renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
    } else {
      buildingEntries.sort(([, a], [, b]) => a.name.localeCompare(b.name, 'ja')); // Sort by name
      buildingEntries.forEach(([id, building]) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = building.name;
        buildingSelectElement.appendChild(option);
      });
      buildingSelectElement.disabled = false;

      // Try to restore last used building for this project
      const lastBuildingForThisProject = localStorage.getItem('lastBuildingId') === currentBuildingId ? currentBuildingId : null; // Check if lastBuildingId belongs to current project
      
      if (lastBuildingForThisProject && buildings[lastBuildingForThisProject]) {
         console.log(`[Building Listener] Restoring last used building: ${lastBuildingForThisProject}`);
         buildingSelectElement.value = lastBuildingForThisProject;
         currentBuildingId = lastBuildingForThisProject;
         activeBuildingNameSpanElement.textContent = buildings[lastBuildingForThisProject].name;
      } else if (buildingEntries.length > 0) {
         // Select the first building if no last used or if last used is invalid
         const firstBuildingId = buildingEntries[0][0];
         console.log(`[Building Listener] Selecting first building: ${firstBuildingId}`);
         buildingSelectElement.value = firstBuildingId;
         currentBuildingId = firstBuildingId;
         activeBuildingNameSpanElement.textContent = buildings[firstBuildingId].name;
         localStorage.setItem('lastBuildingId', currentBuildingId); // Store the newly selected building ID
      } else {
         // Should not happen if buildingEntries.length > 0, but handle defensively
         activeBuildingNameSpanElement.textContent = '未選択';
         currentBuildingId = null;
         localStorage.removeItem('lastBuildingId');
      }
      
      // Fetch deteriorations for the selected building
      if (currentBuildingId) {
          fetchAndRenderDeteriorations(projectId, currentBuildingId, deteriorationTableBodyElement, nextIdDisplayElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
      }
    }
  };

  // Attach the listener and store it
  buildingsDataRef.on('value', listenerCallback, (error) => {
    console.error("Error attaching building listener:", error);
    buildingSelectElement.innerHTML = '<option value="">読込エラー</option>';
    buildingSelectElement.disabled = true;
    buildings = {}; // Clear cache on error
  });

  buildingsListener = { projectId: projectId, ref: buildingsDataRef, callback: listenerCallback };
  console.log(`[updateBuildingSelectorForProject] Attached new building listener for project ${projectId}`);
}

async function fetchAndRenderDeteriorations(projectId, buildingId, deteriorationTableBodyElement, nextIdDisplayElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput) {
  if (!projectId || !buildingId) {
    console.log("[fetchAndRenderDeteriorations] Missing projectId or buildingId.");
    renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput); // Clear table
    updateNextIdDisplay(projectId, buildingId, nextIdDisplayElement); // Reset ID display
    return;
  }
  console.log(`[fetchAndRenderDeteriorations] Fetching for Project: ${projectId}, Building: ${buildingId}`);

  // Setup real-time listener for deterioration data
  setupDeteriorationListener(projectId, buildingId, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);

  // Update the next ID display based on the counter
  await updateNextIdDisplay(projectId, buildingId, nextIdDisplayElement);
}

// ======================================================================
// 9. Data Loading - Basic Info
// ======================================================================
async function loadBasicInfo(projectId, siteNameInput) { 
  console.log(`[loadBasicInfo] Loading basic info for project ID: ${projectId}`);
  const infoRef = getProjectInfoRef(projectId);
  try {
    const snapshot = await infoRef.once('value');
    const info = snapshot.val();
    if (info) {
      console.log("[loadBasicInfo] Found info:", info);
      siteNameInput.value = info.siteName || '';
    } else {
      console.log("[loadBasicInfo] No info found for this project.");
      siteNameInput.value = '';
    }
  } catch (error) {
    console.error("Error loading basic info:", error);
    siteNameInput.value = '';
  }
}

// ======================================================================
// NEW Utility: Manage Recent Project List in localStorage
// ======================================================================
const MAX_RECENT_PROJECTS = 10; // Maximum number of recent projects to store
const RECENT_PROJECTS_KEY = 'recentProjectNames';

function getRecentProjectNames() {
  try {
    const stored = localStorage.getItem(RECENT_PROJECTS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (e) {
    console.error("Error reading recent projects from localStorage:", e);
    return [];
  }
}

function addProjectToRecentList(siteName) {
  if (!siteName) return;
  let recentNames = getRecentProjectNames();
  // Remove the name if it already exists to move it to the front
  recentNames = recentNames.filter(name => name !== siteName);
  // Add the new name to the beginning
  recentNames.unshift(siteName);
  // Limit the list size
  recentNames = recentNames.slice(0, MAX_RECENT_PROJECTS);
  try {
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(recentNames));
    console.log(`[addProjectToRecentList] Updated recent projects:`, recentNames);
  } catch (e) {
    console.error("Error saving recent projects to localStorage:", e);
  }
}

// ======================================================================
// NEW Utility: Update Datalist with Sorted Options
// ======================================================================
function updateDatalistWithOptions(allProjectNames, projectDataListElement) {
  if (!projectDataListElement) return;

  const recentNames = getRecentProjectNames();
  const recentSet = new Set(recentNames); // For efficient lookup

  // Ensure allProjectNames is an array of unique names
  const uniqueAllProjectNames = [...new Set(allProjectNames)];

  // Separate recent names present in allProjectNames and other names
  const validRecentNames = recentNames.filter(name => uniqueAllProjectNames.includes(name));
  const otherNames = uniqueAllProjectNames
    .filter(name => !recentSet.has(name))
    .sort((a, b) => a.localeCompare(b, 'ja')); // Sort remaining names alphabetically (Japanese)

  // Combine: valid recent first, then others. Ensure uniqueness again just in case.
  const finalSortedNames = [...new Set([...validRecentNames, ...otherNames])];

  // Update the datalist
  projectDataListElement.innerHTML = ''; // Clear existing options
  finalSortedNames.forEach(projectName => {
    const option = document.createElement('option');
    option.value = projectName;
    projectDataListElement.appendChild(option);
  });
  // console.log("[updateDatalistWithOptions] Datalist updated with sorted names:", finalSortedNames.slice(0, 5)); // Log first few
}

// ======================================================================
// 9. Data Loading - Project List (Modified)
// ======================================================================
async function populateProjectDataList(projectDataListElement) {
  console.log("[populateProjectDataList] Populating project data list...");
  const CACHE_KEY = 'projectDataListCache';
  const CACHE_EXPIRY = 5 * 60 * 1000; // 5 minutes cache expiry

  try {
    const cachedData = localStorage.getItem(CACHE_KEY);
    if (cachedData) {
      const { timestamp, data } = JSON.parse(cachedData);
      if (Date.now() - timestamp < CACHE_EXPIRY) {
        console.log("[populateProjectDataList] Using cached project list.");
        return data; // Return cached data (already unique from previous save)
      }
    }
  } catch (e) {
    console.error("Error reading project list cache:", e);
    // Proceed to fetch fresh data if cache read fails
  }

  console.log("[populateProjectDataList] Cache invalid or missing, fetching fresh project list from Firebase.");
  try {
    const snapshot = await database.ref('projects').once('value');
    const projects = snapshot.val();
    let projectNames = [];
    if (projects) {
      projectNames = Object.values(projects)
                         .map(proj => proj?.info?.siteName)
                         .filter(name => name); // Extract names and filter out falsy values
    }
    const uniqueProjectNames = [...new Set(projectNames)]; // Ensure uniqueness
    
    // Store fresh unique data in cache
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), data: uniqueProjectNames }));
      console.log("[populateProjectDataList] Fetched and cached unique project list.");
    } catch (e) {
      console.error("Error saving project list cache:", e);
    }
    return uniqueProjectNames; // Return freshly fetched unique data
  } catch (error) {
    console.error("Error fetching project list from Firebase:", error);
    alert("現場リストの読み込みに失敗しました。");
    return []; // Return empty list on error
  }
}

// ======================================================================
// 10. Data Manipulation - Deterioration Counter
// ======================================================================
async function getNextDeteriorationNumber(projectId, buildingId) {
  if (!projectId || !buildingId) {
      console.warn("[getNextDeteriorationNumber] Missing projectId or buildingId.");
      return 1; // Default to 1 if IDs are missing
  }
  const counterRef = getDeteriorationCounterRef(projectId, buildingId);
  let nextNumber = 1;
  try {
      const result = await counterRef.transaction(currentCounter => {
          // If the counter doesn't exist, initialize it to 1.
          // Otherwise, increment it.
          return (currentCounter || 0) + 1;
      });

      if (result.committed && result.snapshot.exists()) {
          nextNumber = result.snapshot.val();
          console.log(`[getNextDeteriorationNumber] Successfully obtained next number: ${nextNumber} for ${projectId}/${buildingId}`);
      } else {
          console.warn("[getNextDeteriorationNumber] Transaction not committed or snapshot doesn't exist. Defaulting to 1.");
          // Attempt to read the value directly as a fallback, though less reliable
          const fallbackSnapshot = await counterRef.once('value');
          nextNumber = (fallbackSnapshot.val() || 0) + 1; 
      }
  } catch (error) {
      console.error("Error getting next deterioration number:", error);
      // Fallback: try to read the current value and increment, less safe
      try {
        const snapshot = await counterRef.once('value');
        nextNumber = (snapshot.val() || 0) + 1;
      } catch (readError) {
          console.error("Fallback read also failed:", readError);
          nextNumber = 1; // Ultimate fallback
      }
  }
  return nextNumber;
}

// ======================================================================
// 14. Event Listener Setup - Selection Changes (Site/Building) (Modified)
// ======================================================================
function setupSelectionListeners(siteNameInput, projectDataListElement, buildingSelectElement, activeProjectNameSpanElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput) {

  // --- Site Name Input Listener ---  
  const updateAndDisplayDataList = async () => {
      const projectNames = await populateProjectDataList(projectDataListElement); // Fetch or get from cache
      updateDatalistWithOptions(projectNames, projectDataListElement); // Update datalist UI
  };

  // Update datalist when the input gets focus
  siteNameInput.addEventListener('focus', updateAndDisplayDataList);

  siteNameInput.addEventListener('change', async () => {
    const selectedSiteName = siteNameInput.value.trim();
    const projectId = generateProjectId(selectedSiteName);
    console.log(`[Site Name Change] Selected site: ${selectedSiteName}, Generated ID: ${projectId}`);

    if (!projectId) {
      // Handle case where input is cleared or invalid
      console.log("[Site Name Change] No project ID generated, resetting UI.");
      currentProjectId = null;
      currentBuildingId = null;
      buildingSelectElement.innerHTML = '<option value="">-- 現場を先に選択 --</option>';
      buildingSelectElement.disabled = true;
      activeProjectNameSpanElement.textContent = '未選択';
      activeBuildingNameSpanElement.textContent = '未選択';
      localStorage.removeItem('lastProjectId');
      localStorage.removeItem('lastBuildingId');
      updateNextIdDisplay(null, null, nextIdDisplayElement);
      renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
      return;
    }

    // Check if the entered project actually exists in Firebase
    const projectInfoRef = getProjectInfoRef(projectId);
    const snapshot = await projectInfoRef.once('value');
    if (snapshot.exists() && snapshot.val().siteName === selectedSiteName) {
      // Project exists, update state and UI
      console.log("[Site Name Change] Project exists. Updating UI and loading buildings.");
      currentProjectId = projectId;
      activeProjectNameSpanElement.textContent = selectedSiteName;
      localStorage.setItem('lastProjectId', currentProjectId);
      
      // Add to recent list and update datalist order
      addProjectToRecentList(selectedSiteName);
      await updateAndDisplayDataList(); // Use await here to ensure datalist is updated before proceeding
      
      // Load other related data
      await loadBasicInfo(currentProjectId, siteNameInput);
      await updateBuildingSelectorForProject(currentProjectId, buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
    } else {
      // Project does not exist or name mismatch
      console.log("[Site Name Change] Entered project name does not exist in database. Resetting related fields.");
      currentProjectId = null;
      currentBuildingId = null;
      buildingSelectElement.innerHTML = '<option value="">-- 現場を先に選択 --</option>';
      buildingSelectElement.disabled = true;
      activeProjectNameSpanElement.textContent = '未選択';
      activeBuildingNameSpanElement.textContent = '未選択';
      localStorage.removeItem('lastProjectId');
      localStorage.removeItem('lastBuildingId');
      updateNextIdDisplay(null, null, nextIdDisplayElement);
      renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
    }
  });

  // --- Building Select Listener --- (No changes needed here for this feature)
  buildingSelectElement.addEventListener('change', () => handleBuildingSelectChange(buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput));
}

// ======================================================================
// 20. Basic Info Saving (Separate Function)
// ======================================================================
function saveBasicInfo(siteNameInput) {
  const siteName = siteNameInput.value.trim();
  const projectId = generateProjectId(siteName);

  if (projectId) { 
    const infoRef = getProjectInfoRef(projectId);
    infoRef.once('value').then(snapshot => {
      if (snapshot.exists()) {
        const currentSiteName = snapshot.val().siteName;
        if (siteName && siteName !== currentSiteName) {
             infoRef.update({ siteName: siteName })
             .then(() => console.log(`[saveBasicInfo] Site name updated for ${projectId}`))
             .catch(error => console.error("Error updating site name:", error));
        }
      } else {
          console.log(`[saveBasicInfo] Project info for ${projectId} does not exist. No data saved.`);
      }
    }).catch(error => {
        console.error("Error checking project info before saving:", error);
    });

  }
}

// ★ 再追加: setupBasicInfoListeners 関数
function setupBasicInfoListeners(siteNameInput) {
    const saveSiteNameHandler = () => saveBasicInfo(siteNameInput);
    // Save on blur (when focus leaves the input)
    siteNameInput.addEventListener('blur', saveSiteNameHandler);
    console.log("[setupBasicInfoListeners] Listener for siteNameInput attached.");
}

// ======================================================================
// 18. Initialization (Modified)
// ======================================================================
async function initializeApp() {
  console.log("Initializing app...");

  // DOM Element References (Ensure all needed elements are here)
  const infoTabBtn = document.getElementById('infoTabBtn');
  const detailTabBtn = document.getElementById('detailTabBtn');
  const infoTab = document.getElementById('infoTab');
  const detailTab = document.getElementById('detailTab');
  const siteNameInput = document.getElementById('siteName');
  const projectDataListElement = document.getElementById('projectDataList'); // Crucial for the datalist updates
  const addBuildingBtn = document.getElementById('addBuildingBtn');
  const buildingSelectPresetElement = document.getElementById('buildingSelectPreset');
  const buildingSelectElement = document.getElementById('buildingSelect');
  const activeProjectNameSpanElement = document.getElementById('activeProjectName');
  const activeBuildingNameSpanElement = document.getElementById('activeBuildingName');
  const deteriorationForm = document.getElementById('deteriorationForm');
  const locationInput = document.getElementById('locationInput');
  const locationPredictionsElement = document.getElementById('locationPredictions');
  const deteriorationNameInput = document.getElementById('deteriorationNameInput');
  const suggestionsElement = document.getElementById('suggestions');
  const photoNumberInput = document.getElementById('photoNumberInput');
  const nextIdDisplayElement = document.getElementById('nextIdDisplay');
  const submitDeteriorationBtn = document.getElementById('submitDeteriorationBtn');
  const continuousAddBtn = document.getElementById('continuousAddBtn');
  const deteriorationTableBodyElement = document.getElementById('deteriorationTableBody');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  const currentYearSpan = document.getElementById('currentYear');
  const editModalElement = document.getElementById('editModal');
  const editForm = document.getElementById('editForm');
  const editIdDisplay = document.getElementById('editIdDisplay');
  const editLocationInput = document.getElementById('editLocationInput');
  const editLocationPredictionsElement = document.getElementById('editLocationPredictions');
  const editDeteriorationNameInput = document.getElementById('editDeteriorationNameInput');
  const editSuggestionsElement = document.getElementById('editSuggestions');
  const editPhotoNumberInput = document.getElementById('editPhotoNumberInput');
  const cancelEditBtn = document.getElementById('cancelEditBtn');

  // Load prediction data (CSV files)
  await loadPredictionData();

  // --- Event Listeners Setup ---
  // Tab switching
  infoTabBtn.addEventListener('click', () => switchTab('info', infoTabBtn, detailTabBtn, infoTab, detailTab));
  detailTabBtn.addEventListener('click', () => {
    switchTab('detail', infoTabBtn, detailTabBtn, infoTab, detailTab);
  });

  // Basic Info saving (site name only)
  setupBasicInfoListeners(siteNameInput);

  // Add Project/Building
  addBuildingBtn.addEventListener('click', () => handleAddProjectAndBuilding(
    siteNameInput, 
    buildingSelectPresetElement, 
    projectDataListElement, 
    buildingSelectElement, 
    activeProjectNameSpanElement, 
    activeBuildingNameSpanElement, 
    nextIdDisplayElement, 
    deteriorationTableBodyElement, 
    editModalElement, 
    editIdDisplay, 
    editLocationInput, 
    editDeteriorationNameInput, 
    editPhotoNumberInput,
    infoTabBtn, 
    detailTabBtn, 
    infoTab, 
    detailTab
  ));

  // Site/Building Selection (Sets up focus and change listeners for siteNameInput)
  setupSelectionListeners(
      siteNameInput, 
      projectDataListElement, 
      buildingSelectElement, 
      activeProjectNameSpanElement, 
      activeBuildingNameSpanElement, 
      nextIdDisplayElement, 
      deteriorationTableBodyElement, 
      editModalElement, 
      editIdDisplay, 
      editLocationInput, 
      editDeteriorationNameInput, 
      editPhotoNumberInput
  );

  // Deterioration Form Submission
  deteriorationForm.addEventListener('submit', (event) => handleDeteriorationSubmit(event, locationInput, deteriorationNameInput, photoNumberInput, nextIdDisplayElement));
  continuousAddBtn.addEventListener('click', () => handleContinuousAdd(photoNumberInput, nextIdDisplayElement));

  // Input Predictions (Deterioration Form)
  setupPredictionListeners(locationInput, locationPredictionsElement, generateLocationPredictions, 'deteriorationNameInput');
  setupPredictionListeners(deteriorationNameInput, suggestionsElement, generateDeteriorationPredictions, 'photoNumberInput');

  // Edit Modal Handling
  editForm.addEventListener('submit', (event) => handleEditSubmit(event, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput, editModalElement));
  cancelEditBtn.addEventListener('click', () => editModalElement.classList.add('hidden'));
  setupPredictionListeners(editLocationInput, editLocationPredictionsElement, generateLocationPredictions, 'editDeteriorationNameInput');
  setupPredictionListeners(editDeteriorationNameInput, editSuggestionsElement, generateDeteriorationPredictions, 'editPhotoNumberInput');

  // CSV Export
  exportCsvBtn.addEventListener('click', () => handleExportCsv(siteNameInput, buildingSelectElement));

  // Footer Year
  currentYearSpan.textContent = new Date().getFullYear();

  // --- Initial State Loading ---
  // Fetch initial project list (from cache or Firebase)
  const initialProjectNames = await populateProjectDataList(projectDataListElement);
  // Populate the datalist with sorted names (recent first)
  updateDatalistWithOptions(initialProjectNames, projectDataListElement);

  // Load last used project and building from localStorage
  const lastProjectId = localStorage.getItem('lastProjectId');
  const lastBuildingId = localStorage.getItem('lastBuildingId');

  if (lastProjectId) {
    console.log(`[Init] Found last project ID: ${lastProjectId}`);
    currentProjectId = lastProjectId;
    // Load basic info (site name) for the last project
    await loadBasicInfo(currentProjectId, siteNameInput);
    
    // Get the site name associated with the loaded project ID
    const projectInfoRef = getProjectInfoRef(currentProjectId);
    const infoSnapshot = await projectInfoRef.once('value');
    let restoredSiteName = '不明な現場';
    if (infoSnapshot.exists()) {
        restoredSiteName = infoSnapshot.val().siteName || '不明な現場';
        activeProjectNameSpanElement.textContent = restoredSiteName;
        // Add the restored site name to the recent list (or move it up)
        // This ensures the last session's project starts at the top
        addProjectToRecentList(restoredSiteName);
        // Re-populate the datalist immediately to reflect the updated recent list
        updateDatalistWithOptions(initialProjectNames, projectDataListElement);
    } else {
        activeProjectNameSpanElement.textContent = restoredSiteName;
        console.warn(`[Init] Could not find info for last project ID: ${lastProjectId}`);
    }

    // Load buildings for the restored project
    await updateBuildingSelectorForProject(currentProjectId, buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);

    // Load last used building if applicable
    if (lastBuildingId && buildings[lastBuildingId]) { 
      console.log(`[Init] Found last building ID: ${lastBuildingId}`);
      currentBuildingId = lastBuildingId;
      buildingSelectElement.value = currentBuildingId;
      activeBuildingNameSpanElement.textContent = buildings[currentBuildingId]?.name || '不明な建物';
      await fetchAndRenderDeteriorations(currentProjectId, currentBuildingId, deteriorationTableBodyElement, nextIdDisplayElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
      switchTab('detail', infoTabBtn, detailTabBtn, infoTab, detailTab);
    } else {
        console.log(`[Init] Last building ID (${lastBuildingId}) not found or invalid for project ${lastProjectId}. Staying on info tab.`);
        activeBuildingNameSpanElement.textContent = '未選択';
        updateNextIdDisplay(currentProjectId, null, nextIdDisplayElement); 
        renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
    }
  } else {
    // No last project ID found
    console.log("[Init] No last project ID found. Staying on info tab.");
    activeProjectNameSpanElement.textContent = '未選択';
    activeBuildingNameSpanElement.textContent = '未選択';
    buildingSelectElement.innerHTML = '<option value="">-- 現場を先に選択 --</option>';
    buildingSelectElement.disabled = true;
    updateNextIdDisplay(null, null, nextIdDisplayElement); 
    renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
  }

  console.log("App initialized.");
}

// Run initialization when the DOM is ready
document.addEventListener('DOMContentLoaded', initializeApp); 