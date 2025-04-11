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
      li.classList.add('px-3', 'py-1', 'cursor-pointer', 'hover:bg-blue-100', 'list-none', 'text-sm'); // paddingをpy-1に

      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        inputElement.value = prediction;
        hidePredictions(predictionListElement);

        // ★★★ フォーカス移動処理を追加 ★★★
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
          nextFocusElement.focus();
        }
        // ★★★ ここまで ★★★
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
// 8. Core Data Loading & UI Setup Functions
// ======================================================================
async function loadProjectsAndSetupSelector(projectSelectElement, buildingSelectElement) {
    console.log("[loadProjectsAndSetupSelector] Loading projects...");
    projectSelectElement.innerHTML = '<option value="">-- 現場を選択 --</option>'; 
    buildingSelectElement.innerHTML = '<option value="">-- 現場を先に選択 --</option>';
    buildingSelectElement.disabled = true;
    try {
        const projectsRef = database.ref('projects');
        const snapshot = await projectsRef.once('value');
        const projectsData = snapshot.val();
        if (projectsData) {
            const projectPromises = Object.keys(projectsData).map(async (projectId) => {
                const infoSnap = await getProjectInfoRef(projectId).once('value');
                const infoData = infoSnap.val();
                return { id: projectId, name: infoData?.siteName || projectId }; 
            });
            const projectsList = await Promise.all(projectPromises);
            projectsList.sort((a, b) => a.name.localeCompare(b.name, 'ja'));

            // ★ 重複排除ロジックを追加
            const addedNames = new Set(); // 追加済みの現場名を記録するSet
            projectsList.forEach(project => {
                // まだ追加されていない現場名の場合のみオプションを追加
                if (!addedNames.has(project.name)) {
                    const option = document.createElement('option');
                    option.value = project.id; // value には projectId を保持
                    option.textContent = project.name;
                    projectSelectElement.appendChild(option);
                    addedNames.add(project.name); // 追加済みとして記録
                } else {
                    // 重複する現場名が見つかった場合の処理（例：コンソールに警告）
                    console.warn(`[loadProjectsAndSetupSelector] Duplicate site name found: "${project.name}" (Project ID: ${project.id} was skipped)`);
                }
            });
            // ★ 重複排除ここまで
            console.log(`[loadProjectsAndSetupSelector] Loaded ${projectsList.length} unique projects.`);
        } else {
            console.log("[loadProjectsAndSetupSelector] No projects found.");
        }
    } catch (error) {
        console.error("[loadProjectsAndSetupSelector] Error loading projects:", error);
        alert("現場リストの読み込み中にエラーが発生しました。");
    }
}

async function updateBuildingSelectorForProject(projectId, buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput) {
    console.log(`[updateBuildingSelectorForProject] Updating for projectId: ${projectId}`);
    buildingSelectElement.innerHTML = ''; 
    activeBuildingNameSpanElement.textContent = '';
    renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
    nextIdDisplayElement.textContent = '1'; 
    detachAllDeteriorationListeners();
    currentBuildingId = null; 
    buildings = {}; 

    if (!projectId) {
        buildingSelectElement.innerHTML = '<option value="">-- 現場を選択 --</option>';
        buildingSelectElement.disabled = true;
        return;
    }

    buildingSelectElement.disabled = false; 
    buildingSelectElement.innerHTML = '<option value="">-- 建物を選択 --</option>';

    try {
        const buildingsRef = getBuildingsRef(projectId);
        if (buildingsListener) { buildingsRef.off('value', buildingsListener); }

        buildingsListener = buildingsRef.on('value', (snapshot) => {
            buildingSelectElement.innerHTML = '<option value="">-- 建物を選択 --</option>'; 
            buildings = snapshot.val() || {}; 
            const buildingsList = Object.entries(buildings).map(([id, data]) => ({ id, name: data.name })).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
            buildingsList.forEach(({ id, name }) => {
                const option = document.createElement('option');
                option.value = id;
                option.textContent = name;
                buildingSelectElement.appendChild(option);
            });
            console.log(`[updateBuildingSelectorForProject] Populated ${buildingsList.length} buildings for ${projectId}.`);
        }, (error) => {
            console.error(`[updateBuildingSelectorForProject] Firebase listener error for buildings in ${projectId}:`, error);
            buildingSelectElement.innerHTML = '<option value="">読込エラー</option>';
            buildingSelectElement.disabled = true;
        });
    } catch (error) {
        console.error(`[updateBuildingSelectorForProject] Error fetching buildings for project ${projectId}:`, error);
        buildingSelectElement.innerHTML = '<option value="">読込エラー</option>';
        buildingSelectElement.disabled = true;
    }
}

// ★ NEW: Function to fetch/render deteriorations AND setup listener
async function fetchAndRenderDeteriorations(projectId, buildingId, deteriorationTableBodyElement, nextIdDisplayElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput) {
    console.log(`[fetchAndRenderDeteriorations] Fetching for Project: ${projectId}, Building: ${buildingId}`);
    if (!projectId || !buildingId) {
        renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
        nextIdDisplayElement.textContent = '1';
        return;
    }
    
    detachAllDeteriorationListeners(); // Ensure no old listeners are running

    try {
        // 1. Fetch initial data
        const deteriorationsRef = getDeteriorationsRef(projectId, buildingId);
        const snapshot = await deteriorationsRef.once('value');
        const initialData = snapshot.val() || {};
        deteriorationData[buildingId] = initialData; // Update global cache
        console.log(`[fetchAndRenderDeteriorations] Initial data fetched for ${buildingId}:`, initialData);
        
        // 2. Render initial data
        const records = Object.entries(initialData).map(([id, data]) => ({ id, ...data })).sort((a, b) => a.number - b.number); 
        renderDeteriorationTable(records, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
        
        // 3. Update the next ID display based on fetched data
        await updateNextIdDisplay(projectId, buildingId, nextIdDisplayElement);
        
        // 4. Setup real-time listener for future updates
        setupDeteriorationListener(projectId, buildingId, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);

    } catch (error) {
        console.error(`[fetchAndRenderDeteriorations] Error fetching/rendering deteriorations for ${buildingId}:`, error);
        renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
        nextIdDisplayElement.textContent = '-'; 
        alert(`劣化情報の読み込み中にエラーが発生しました: ${error.message}`);
    }
}

async function loadBasicInfo(projectId, surveyDateInput, siteNameInput) {
  if (!projectId) return;
  try {
    const snapshot = await getProjectInfoRef(projectId).once('value');
    const info = snapshot.val();
    if (info) {
      surveyDateInput.value = info.surveyDate || '';
      siteNameInput.value = info.siteName || '';
      console.log("Basic info loaded for project:", projectId);
    } else {
      console.log("No basic info found for project:", projectId);
      surveyDateInput.value = '';
      siteNameInput.value = '';
    }
  } catch (error) {
    console.error("Error loading basic info:", error);
    surveyDateInput.value = '';
    siteNameInput.value = '';
  }
}

// ★★★ getNextDeteriorationNumber 関数を追加 ★★★
async function getNextDeteriorationNumber(projectId, buildingId) {
  if (!projectId || !buildingId) return null;
  const counterRef = getDeteriorationCounterRef(projectId, buildingId);
  try {
    // Use a transaction to safely increment the counter
    const result = await counterRef.transaction(currentValue => (currentValue || 0) + 1);
    if (result.committed) {
      const nextNumber = result.snapshot.val();
      console.log(`Next deterioration number for ${buildingId}:`, nextNumber);
      return nextNumber;
    } else {
      console.error('Transaction aborted for deterioration counter');
      return null; // Indicate failure
    }
  } catch (error) {
    console.error("Error getting next deterioration number:", error);
    return null; // Indicate failure
  }
}

// ======================================================================
// 9. Event Handlers
// ======================================================================
async function handleAddProjectAndBuilding(surveyDateInput, siteNameInput, buildingNameInput, projectSelectElement, buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput, infoTabBtn, detailTabBtn, infoTab, detailTab) {
    const surveyDate = surveyDateInput.value;
    const siteName = siteNameInput.value.trim();
    const buildingName = buildingNameInput.value.trim();
    if (!surveyDate || !siteName || !buildingName) { alert('調査日、現場名、建物名をすべて入力してください。'); return; }
    
    const projectId = generateProjectId(siteName);
    const buildingId = generateBuildingId(buildingName);
    if (!projectId || !buildingId) { alert('ID生成エラー'); return; }
    console.log(`Adding project '${projectId}', building '${buildingId}'`);
    
    try {
        await Promise.all([
            getProjectInfoRef(projectId).set({ siteName: siteName, surveyDate: surveyDate }),
            getBuildingsRef(projectId).child(buildingId).set({ name: buildingName })
        ]);
        console.log(`Success: Added/Updated project '${projectId}', building '${buildingId}'.`);
        
        currentProjectId = projectId;
        currentBuildingId = buildingId;
        localStorage.setItem('lastProjectId', currentProjectId);
        localStorage.setItem('lastBuildingId', currentBuildingId); // Store new building as last used
        
        // Update UI - Reload project list to include the new one
        await loadProjectsAndSetupSelector(projectSelectElement, buildingSelectElement);
        projectSelectElement.value = projectId; // Select the newly added project
        
        // Update building list for the selected project (will include the new one)
        await updateBuildingSelectorForProject(projectId, buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
        
        // Short delay to ensure building options are populated by listener
        await new Promise(resolve => setTimeout(resolve, 250)); 
        
        if (buildingSelectElement.querySelector(`option[value="${buildingId}"]`)) {
             buildingSelectElement.value = buildingId; // Select the newly added building
             // Manually trigger the handler to load its data
            await handleBuildingSelectChange(buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
        } else {
            console.warn("Newly added building not found in selector immediately after update.");
        }

        switchTab('detail', infoTabBtn, detailTabBtn, infoTab, detailTab);
        buildingNameInput.value = ''; 
        alert(`現場「${siteName}」に建物「${buildingName}」を追加し、選択しました。`);
    } catch (error) {
        console.error('Error adding project and building:', error);
        alert(`プロジェクトと建物の追加中にエラーが発生しました: ${error.message}`);
    }
}

async function handleBuildingSelectChange(buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput) {
    const selectedBuildingId = buildingSelectElement.value;
    console.log(`[BuildingSelect Change] Selected buildingId: ${selectedBuildingId}`);

    if (selectedBuildingId && currentProjectId) {
        currentBuildingId = selectedBuildingId;
        localStorage.setItem('lastBuildingId', currentBuildingId);
        const selectedBuildingName = buildingSelectElement.options[buildingSelectElement.selectedIndex].text;
        activeBuildingNameSpanElement.textContent = escapeHtml(selectedBuildingName);
        // ★ Call the new function to fetch, render, and set up listener
        await fetchAndRenderDeteriorations(currentProjectId, currentBuildingId, deteriorationTableBodyElement, nextIdDisplayElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
    } else {
        currentBuildingId = null;
        localStorage.removeItem('lastBuildingId');
        activeBuildingNameSpanElement.textContent = '';
        renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
        nextIdDisplayElement.textContent = '1';
        detachAllDeteriorationListeners();
    }
}

async function handleDeteriorationSubmit(event, locationInput, deteriorationNameInput, photoNumberInput, nextIdDisplayElement) {
  event.preventDefault();
  if (!currentProjectId || !currentBuildingId) {
    alert("プロジェクトまたは建物が選択されていません。"); return;
  }
  const location = locationInput.value.trim();
  const name = deteriorationNameInput.value.trim();
  const photoNumber = photoNumberInput.value.trim();
  if (!location || !name) { alert("場所と劣化名を入力してください。"); return; }
  const nextNumber = await getNextDeteriorationNumber(currentProjectId, currentBuildingId);
  if (nextNumber === null) { alert("劣化番号の取得に失敗しました。もう一度試してください。"); return; }
  const newData = { number: nextNumber, location, name, photoNumber: photoNumber || '' };
  try {
    const deteriorationRef = getDeteriorationsRef(currentProjectId, currentBuildingId);
    await deteriorationRef.push(newData);
    console.log(`Deterioration data added for ${currentBuildingId}:`, newData);
    recordLastAddedData(location, name); // Uses global lastAdded...
    locationInput.value = '';
    deteriorationNameInput.value = '';
    photoNumberInput.value = '';
    updateNextIdDisplay(currentProjectId, currentBuildingId, nextIdDisplayElement);
  } catch (error) {
    console.error("Error adding deterioration data:", error);
    alert("劣化情報の追加に失敗しました。");
  }
}

function handleEditClick(projectId, buildingId, recordId, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput) {
  if (!deteriorationData[buildingId] || !deteriorationData[buildingId][recordId]) {
    console.error(`Record ${recordId} not found for building ${buildingId}`); return;
  }
  const record = deteriorationData[buildingId][recordId];
  console.log(`Editing record ${recordId} for building ${buildingId}:`, record);
  currentEditRecordId = recordId;
  editModalElement.classList.remove('hidden');
  editIdDisplay.textContent = record.number;
  editLocationInput.value = record.location;
  editDeteriorationNameInput.value = record.name;
  editPhotoNumberInput.value = record.photoNumber;
}

async function handleEditSubmit(event, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput, editModalElement) {
  event.preventDefault();
  if (!currentProjectId || !currentBuildingId || !currentEditRecordId) {
    alert("編集対象の情報が正しくありません。"); return;
  }
  const updatedData = {
    number: parseInt(editIdDisplay.textContent, 10), 
    location: editLocationInput.value.trim(),
    name: editDeteriorationNameInput.value.trim(),
    photoNumber: editPhotoNumberInput.value.trim()
  };
  if (!updatedData.location || !updatedData.name) { alert("場所と劣化名は必須です。"); return; }
  try {
    const recordRef = getDeteriorationsRef(currentProjectId, currentBuildingId).child(currentEditRecordId);
    await recordRef.update(updatedData);
    console.log(`Record ${currentEditRecordId} updated successfully.`);
    editModalElement.classList.add('hidden'); 
    currentEditRecordId = null; 
  } catch (error) {
    console.error("Error updating record:", error);
    alert("情報の更新に失敗しました。");
  }
}

async function handleDeleteClick(projectId, buildingId, recordId, recordNumber) {
  if (!projectId) return;
  if (confirm(`番号 ${recordNumber} の劣化情報「${deteriorationData[buildingId]?.[recordId]?.name || '' }」を削除しますか？`)) {
    try {
      const recordRef = getDeteriorationsRef(projectId, buildingId).child(recordId);
      await recordRef.remove();
      console.log(`Record ${recordId} deleted successfully.`);
    } catch (error) {
      console.error("Error deleting record:", error);
      alert("情報の削除に失敗しました。");
    }
  }
}

function recordLastAddedData(location, name) {
  lastAddedLocation = location;
  lastAddedName = name;
  console.log("Recorded last added data for continuous add:", { location, name });
}

async function handleContinuousAdd(photoNumberInput, nextIdDisplayElement) {
  if (!currentProjectId || !currentBuildingId) { alert("プロジェクトまたは建物が選択されていません。"); return; }
  if (!lastAddedLocation || !lastAddedName) { alert("連続登録する元データがありません。一度通常登録を行ってください。"); return; }
  const photoNumber = photoNumberInput.value.trim();
  const nextNumber = await getNextDeteriorationNumber(currentProjectId, currentBuildingId);
  if (nextNumber === null) { alert("劣化番号の取得に失敗しました。もう一度試してください。"); return; }
  const newData = { number: nextNumber, location: lastAddedLocation, name: lastAddedName, photoNumber: photoNumber || '' };
  try {
    const deteriorationRef = getDeteriorationsRef(currentProjectId, currentBuildingId);
    await deteriorationRef.push(newData);
    console.log(`Continuous deterioration data added for ${currentBuildingId}:`, newData);
    photoNumberInput.value = '';
    updateNextIdDisplay(currentProjectId, currentBuildingId, nextIdDisplayElement);
  } catch (error) {
    console.error("Error adding continuous deterioration data:", error);
    alert("連続登録に失敗しました。");
  }
}

// ======================================================================
// 10. Listener Setup Functions
// ======================================================================
function setupBasicInfoListeners(surveyDateInput, siteNameInput) {
  // ★ surveyDate の変更時のみ saveBasicInfo を呼ぶ
  const saveDateHandler = () => saveBasicInfo(surveyDateInput, siteNameInput); // siteNameInputは渡しても良いが使わない想定
  surveyDateInput.addEventListener('change', saveDateHandler);
  // siteName の変更は addProjectBtn で行うためリスナー削除
  // siteNameInput.addEventListener('change', saveHandler);
  console.log("[setupBasicInfoListeners] Listener for surveyDate attached.");
}

// Modified to set up listeners for both project and building selects
function setupBuildingManagementListeners(projectSelectElement, buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput) {
    console.log("[setupBuildingManagementListeners] Setting up listeners...");
    // Project Selection Change Listener
    projectSelectElement.addEventListener('change', async (event) => {
        const selectedProjectId = event.target.value;
        console.log(`[ProjectSelect Change] Selected projectId: ${selectedProjectId}`);
        currentProjectId = selectedProjectId; 
        localStorage.setItem('lastProjectId', currentProjectId);
        currentBuildingId = null; // Reset building context
        localStorage.removeItem('lastBuildingId'); 
        // Update building selector based on the selected project
        await updateBuildingSelectorForProject(
            selectedProjectId, buildingSelectElement, activeBuildingNameSpanElement, 
            nextIdDisplayElement, deteriorationTableBodyElement, 
            editModalElement, editIdDisplay, editLocationInput, 
            editDeteriorationNameInput, editPhotoNumberInput
        );
    });

    // Building Selection Change Listener - Calls the handler
    buildingSelectElement.addEventListener('change', () => handleBuildingSelectChange(
        buildingSelectElement, activeBuildingNameSpanElement, 
        nextIdDisplayElement, deteriorationTableBodyElement, 
        editModalElement, editIdDisplay, editLocationInput, 
        editDeteriorationNameInput, editPhotoNumberInput
    ));
}

// Sets up the real-time listener for a specific building's deteriorations
function setupDeteriorationListener(projectId, buildingId, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput) {
    if (!projectId || !buildingId) return;
    console.log(`---> [setupDeteriorationListener] Attaching listener for ${buildingId}`);
    const ref = getDeteriorationsRef(projectId, buildingId);
    // Ensure old listener for this specific building is detached if re-attaching
    if (deteriorationListeners[buildingId] && typeof deteriorationListeners[buildingId].off === 'function') {
        deteriorationListeners[buildingId].off();
    }
    deteriorationListeners[buildingId] = ref; // Store the ref itself
    ref.on('value', (snapshot) => {
        const newData = snapshot.val() || {};
        deteriorationData[buildingId] = newData; // Update cache
        // Only re-render if this is the currently selected building
        if (buildingId === currentBuildingId) {
            console.log(`[Listener Callback] Data changed for current building ${buildingId}, rendering.`);
             const records = Object.entries(newData).map(([id, data]) => ({ id, ...data })).sort((a, b) => a.number - b.number); 
            renderDeteriorationTable(records, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
            // Optionally update next ID display based on listener update?
            // updateNextIdDisplay(projectId, buildingId, nextIdDisplayElement); 
        } else {
            console.log(`[Listener Callback] Data received for non-current building ${buildingId}.`);
        }
    }, (error) => { console.error(`Error listening for deteriorations for ${buildingId}:`, error); });
}

function detachAllDeteriorationListeners() {
  console.log("[detachAllDeteriorationListeners] Detaching all..."); 
  Object.entries(deteriorationListeners).forEach(([buildingId, listenerRef]) => {
    if (listenerRef && typeof listenerRef.off === 'function') { 
      listenerRef.off();
      console.log(`Detached deterioration listener for ${buildingId}`);
    } else {
      console.warn(`Invalid listenerRef found for building ${buildingId} in deteriorationListeners.`);
    }
  });
  deteriorationListeners = {}; 
  deteriorationData = {}; 
  console.log("[detachAllDeteriorationListeners] Detach complete. deteriorationListeners reset."); 
}

// ======================================================================
// 11. Initialization (Refactored)
// ======================================================================
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded and parsed. Initializing app...");
    initializeApp(); // Call the main initialization function
});

async function initializeApp() {
    // --- 1. Get Global Element References ---
    const surveyDateInput = document.getElementById('surveyDate');
    const siteNameInput = document.getElementById('siteName');
    const buildingNameInput = document.getElementById('buildingName');
    const addBuildingBtn = document.getElementById('addBuildingBtn');
    const projectSelectElement = document.getElementById('projectSelect');
    const buildingSelectElement = document.getElementById('buildingSelect');
    const activeBuildingNameSpanElement = document.getElementById('activeBuildingName');
    const infoTabBtn = document.getElementById('infoTabBtn');
    const detailTabBtn = document.getElementById('detailTabBtn');
    const infoTab = document.getElementById('infoTab');
    const detailTab = document.getElementById('detailTab');
    const deteriorationForm = document.getElementById('deteriorationForm');
    const locationInput = document.getElementById('locationInput');
    const deteriorationNameInput = document.getElementById('deteriorationNameInput');
    const photoNumberInput = document.getElementById('photoNumberInput');
    const nextIdDisplayElement = document.getElementById('nextIdDisplay');
    const deteriorationTableBodyElement = document.getElementById('deteriorationTableBody');
    const editModalElement = document.getElementById('editModal');
    const editForm = document.getElementById('editForm');
    const editIdDisplay = document.getElementById('editIdDisplay');
    const editLocationInput = document.getElementById('editLocationInput');
    const editDeteriorationNameInput = document.getElementById('editDeteriorationNameInput');
    const editPhotoNumberInput = document.getElementById('editPhotoNumberInput');
    const cancelEditBtn = document.getElementById('cancelEditBtn');
    const exportCsvBtn = document.getElementById('exportCsvBtn');
    const currentYearSpan = document.getElementById('currentYear');
    const continuousAddBtn = document.getElementById('continuousAddBtn');
    const locationPredictionsList = document.getElementById('locationPredictions');
    const suggestionsContainer = document.getElementById('suggestions'); // 新しい候補表示用コンテナのID (HTML側と合わせる)
    const editLocationPredictionsList = document.getElementById('editLocationPredictions');
    const editSuggestionsContainer = document.getElementById('editSuggestions'); // 編集モーダル用のID (HTML側と合わせる)

    // --- 2. Initial UI Setup ---
    currentYearSpan.textContent = new Date().getFullYear();
    switchTab('info', infoTabBtn, detailTabBtn, infoTab, detailTab); // Default to info tab

    // --- 3. Load Prediction Data ---
    await loadPredictionData();
    console.log("Prediction data loading complete.");

    // --- 4. Load Project List ---
    await loadProjectsAndSetupSelector(projectSelectElement, buildingSelectElement);
    console.log("Project list loading complete.");

    // --- 5. Restore Last State (Project & Building) ---
    const lastProjectId = localStorage.getItem('lastProjectId');
    if (lastProjectId && projectSelectElement.querySelector(`option[value="${lastProjectId}"]`)) {
        console.log(`Restoring last project: ${lastProjectId}`);
        projectSelectElement.value = lastProjectId;
        currentProjectId = lastProjectId; 
        await loadBasicInfo(currentProjectId, surveyDateInput, siteNameInput);
        await updateBuildingSelectorForProject(currentProjectId, buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
        
        // Wait slightly for building options to populate via listener
        await new Promise(resolve => setTimeout(resolve, 350)); 
        
        const lastBuildingId = localStorage.getItem('lastBuildingId');
        if (lastBuildingId && buildingSelectElement.querySelector(`option[value="${lastBuildingId}"]`)) {
            console.log(`Restoring last building: ${lastBuildingId}`);
            buildingSelectElement.value = lastBuildingId;
            // Fetch and render data for the restored building
            await fetchAndRenderDeteriorations(currentProjectId, lastBuildingId, deteriorationTableBodyElement, nextIdDisplayElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
            currentBuildingId = lastBuildingId; // Ensure global state is set AFTER loading
            activeBuildingNameSpanElement.textContent = escapeHtml(buildingSelectElement.options[buildingSelectElement.selectedIndex].text);
        } else {
             console.log("Last building not found or invalid, leaving building unselected.");
        }
    } else {
        console.log("No valid last project found.");
        currentProjectId = null; // Ensure reset
    }

    // --- 6. Setup ALL Event Listeners --- 
    console.log("Setting up event listeners...");
    // Tabs
    infoTabBtn.addEventListener('click', () => switchTab('info', infoTabBtn, detailTabBtn, infoTab, detailTab));
    detailTabBtn.addEventListener('click', () => {
        if (!currentProjectId || !currentBuildingId) {
            alert("詳細タブを表示するには、まずプロジェクトと建物を選択または追加してください。");
            return;
        }
        switchTab('detail', infoTabBtn, detailTabBtn, infoTab, detailTab);
    });
    // Predictions - ★ リスト要素のIDを修正
    if (locationInput && locationPredictionsList) setupPredictionListeners(locationInput, locationPredictionsList, generateLocationPredictions, 'deteriorationNameInput');
    if (deteriorationNameInput && suggestionsContainer) setupPredictionListeners(deteriorationNameInput, suggestionsContainer, generateDeteriorationPredictions, 'photoNumberInput'); // ★ 修正
    if (editLocationInput && editLocationPredictionsList) setupPredictionListeners(editLocationInput, editLocationPredictionsList, generateLocationPredictions, 'editDeteriorationNameInput');
    if (editDeteriorationNameInput && editSuggestionsContainer) setupPredictionListeners(editDeteriorationNameInput, editSuggestionsContainer, generateDeteriorationPredictions, 'editPhotoNumberInput'); // ★ 修正
    // Basic Info
    setupBasicInfoListeners(surveyDateInput, siteNameInput);
    // Project/Building Management
    setupBuildingManagementListeners(projectSelectElement, buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
    // Add Project/Building
    if (addBuildingBtn) { addBuildingBtn.addEventListener('click', () => handleAddProjectAndBuilding(surveyDateInput, siteNameInput, buildingNameInput, projectSelectElement, buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput, infoTabBtn, detailTabBtn, infoTab, detailTab)); } else { console.error("Add button not found"); }
    // Forms & Buttons
    if (deteriorationForm) deteriorationForm.addEventListener('submit', (event) => handleDeteriorationSubmit(event, locationInput, deteriorationNameInput, photoNumberInput, nextIdDisplayElement));
    if (editForm) editForm.addEventListener('submit', (event) => handleEditSubmit(event, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput, editModalElement));
    if (cancelEditBtn) cancelEditBtn.addEventListener('click', () => editModalElement.classList.add('hidden'));
    if (continuousAddBtn) continuousAddBtn.addEventListener('click', () => handleContinuousAdd(photoNumberInput, nextIdDisplayElement));
    if (exportCsvBtn) exportCsvBtn.addEventListener('click', () => handleExportCsv(projectSelectElement, buildingSelectElement));

    console.log("Initialization complete.");
}

// ★★★ generateCsvContent 関数定義のコメントアウトを解除 ★★★
function generateCsvContent(buildingId) {
    if (!currentProjectId || !buildingId || !deteriorationData[buildingId]) { alert("エクスポート対象のデータがありません。"); return null; }
    const dataToExport = Object.values(deteriorationData[buildingId]).sort((a, b) => a.number - b.number);
    if (dataToExport.length === 0) { alert(`建物「${buildingId}」にはエクスポートするデータがありません。`); return null; }
    const header = ["番号", "場所", "劣化名", "写真番号"];
    const rows = dataToExport.map(d => [d.number, `"${(d.location || '').replace(/"/g, '""')}"`, `"${(d.name || '').replace(/"/g, '""')}"`, `"${(d.photoNumber || '').replace(/"/g, '""')}"`].join(','));
    const csvContent = "\uFEFF" + header.join(',') + "\n" + rows.join("\n");
    return csvContent;
}

// ★★★ downloadCsv 関数定義のコメントアウトを解除 ★★★
function downloadCsv(csvContent, filename) {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    if (link.download !== undefined) { 
      const url = URL.createObjectURL(blob);
      link.setAttribute("href", url);
      link.setAttribute("download", filename);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url); 
    } else { alert("お使いのブラウザはCSVダウンロードに対応していません。"); }
}

// ★★★ handleExportCsv 関数定義のコメントアウトを解除 ★★★
function handleExportCsv(projectSelectElement, buildingSelectElement) {
    if (!currentProjectId) { alert("プロジェクトが特定できません。基本情報を入力してください。"); return; }
    const targetBuildingId = buildingSelectElement.value;
    if (!targetBuildingId) { alert("CSVをダウンロードする建物を選択してください。"); return; }
    const csvContent = generateCsvContent(targetBuildingId);
    if (csvContent) {
      const siteName = projectSelectElement.options[projectSelectElement.selectedIndex].text || 'プロジェクト'; // Get selected project name
      const safeSiteName = siteName.replace(/[^a-zA-Z0-9_\-]/g, '_');
      const safeBuildingName = buildingSelectElement.options[buildingSelectElement.selectedIndex].text.replace(/[^a-zA-Z0-9_\-]/g, '_'); // Get selected building name
      const filename = `${safeSiteName}_${safeBuildingName}_劣化情報.csv`;
      downloadCsv(csvContent, filename);
    }
} 