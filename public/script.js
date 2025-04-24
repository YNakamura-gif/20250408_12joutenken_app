// ======================================================================
// 1. Firebase Configuration & Initialization
// ======================================================================
const firebaseConfig = {
  apiKey: "AIzaSyDVfcDRu0-91-gWmum-OS-iQMk34PAYq70",
  authDomain: "text-memo-ver2.firebaseapp.com",
  databaseURL: "https://text-memo-ver2-default-rtdb.firebaseio.com",
  projectId: "text-memo-ver2",
  storageBucket: "text-memo-ver2.firebasestorage.app",
  messagingSenderId: "1067081483347",
  appId: "1:1067081483347:web:28a99f942c412c1261b2a6",
  measurementId: "G-P976HM70JN"
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
// let lastAddedPhotoNumber = ''; // ★ 削除: 写真番号は自動採番のため不要
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
  return database.ref(`projects/${projectId}/buildings/${buildingId}/deteriorations`);
}
function getDeteriorationCounterRef(projectId, buildingId) {
  return database.ref(`projects/${projectId}/counters/${buildingId}`);
}
// ★ 修正: 写真番号カウンター用の参照 (変更なし、カウンター自体は利用する)
function getPhotoCounterRef(projectId, buildingId) {
    return database.ref(`projects/${projectId}/photoCounters/${buildingId}`);
}

// ======================================================================
// 4. Utility Functions
// ======================================================================
function generateProjectId(siteName) {
    if (!siteName) return null;
    const safeSiteName = siteName.replace(/[.#$\\[\\]]/g, '_');
    return safeSiteName;
}

function generateBuildingId(buildingName) {
    if (!buildingName) return null;
    const safeBuildingName = buildingName.replace(/[.#$\\[\\]]/g, '_').substring(0, 50);
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

// ★ 削除: enforceHalfWidthDigits 関数は不要
// function enforceHalfWidthDigits(inputElement) { ... }


// ======================================================================
// ★ NEW: Building ID to Photo Number Offset Mapping
// ======================================================================
const BUILDING_PHOTO_OFFSETS = {
  "site": 0, // 敷地
  "buildingA": 1000, // A棟
  "buildingB": 2000, // B棟
  "buildingC": 3000, // C棟
  "buildingD": 4000, // D棟
  "buildingE": 5000, // E棟
  "buildingF": 6000, // F棟
  "buildingG": 7000, // G棟
  "buildingH": 8000, // H棟
  "buildingI": 9000, // I棟
  // 必要に応じて他の建物のマッピングを追加 (IDは generateBuildingId で生成されるもの、または固定値)
};

// Helper function to get the offset for a building ID
function getBuildingPhotoOffset(buildingId) {
    // 未定義の buildingId の場合はデフォルトで 0 (敷地と同じ) を返すか、エラーを出すか検討
    // ここでは 0 を返す (存在しない建物IDが来た場合)
    // buildingId が null や undefined の場合も 0 を返す
    return BUILDING_PHOTO_OFFSETS[buildingId] ?? 0;
}


// ======================================================================
// 5. Data Loading/Parsing (CSV, Predictions)
// ======================================================================
function parseCsv(csvText, expectedColumns) {
  console.log("[parseCsv] Starting parse. Expected columns:", expectedColumns);
  // console.log("[parseCsv] Received text (first 100 chars):", csvText.substring(0, 100));
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length <= 1) {
    console.warn("CSV file has no data or only a header.");
    return [];
  }
  const headerLine = lines.shift();
  // BOM (Byte Order Mark) の除去 (U+FEFF)
  const header = (headerLine.charCodeAt(0) === 0xFEFF ? headerLine.slice(1) : headerLine).split(',');
  console.log("[parseCsv] Header:", header);
  if (header.length < expectedColumns) {
      console.warn(`CSV header has fewer columns (${header.length}) than expected (${expectedColumns}).`);
  }

  return lines.map((line, index) => {
    const values = line.split(',');
    // console.log(`[parseCsv] Line ${index + 1} values:`, values);
    try {
        if (expectedColumns === 3 && header[0]?.trim() === '階数') { // ヘッダーで場所CSVかを判断
          const floor = values[0]?.trim() || '';
          const value = values[1]?.trim();
          const reading = values[2]?.trim();
      return value ? { floor: floor, value: value, reading: reading || '' } : null;
    }
        else if (expectedColumns === 3 && header[0]?.trim() === '劣化名') { // ヘッダーで劣化項目CSVかを判断
      const name = values[0]?.trim();
      const code = values[1]?.trim();
      const reading = values[2]?.trim();
      return name ? { name: name, code: code || '', reading: reading || '' } : null;
    } else {
      console.warn(`Unsupported expectedColumns or unknown CSV format: ${expectedColumns}, Header: ${header[0]}`);
          return null;
        }
    } catch (e) {
        console.error(`Error parsing CSV line ${index + 1}: ${line}`, e);
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
    // 文字コード判定 (Shift_JIS も考慮する場合)
    let text;
    try {
        // UTF-8 で試す
        const decoderUtf8 = new TextDecoder('utf-8', { fatal: true });
        text = decoderUtf8.decode(buffer);
        console.log(`[fetchAndParseCsv] Decoded as UTF-8 from ${filePath}`);
    } catch (e) {
        // UTF-8 で失敗したら Shift_JIS で試す
        try {
            const decoderSjis = new TextDecoder('shift-jis', { fatal: true });
            text = decoderSjis.decode(buffer);
            console.log(`[fetchAndParseCsv] Decoded as Shift_JIS from ${filePath}`);
        } catch (e2) {
            console.error(`Failed to decode ${filePath} as UTF-8 or Shift_JIS. Using fallback.`);
            // フォールバックとして UTF-8 (エラー無視)
            const decoderFallback = new TextDecoder('utf-8');
            text = decoderFallback.decode(buffer);
        }
    }
    // console.log(`[fetchAndParseCsv] Decoded text (first 200 chars):`, text.substring(0, 200));
    // BOM check is integrated into parseCsv header processing now
    return parseCsv(text, expectedColumns); 
  } catch (error) {
    console.error(`Error fetching or parsing CSV ${filePath}:`, error);
    return [];
  }
}

async function loadPredictionData() {
  console.log("Loading prediction data...");
  try {
    [locationPredictions, degradationItemsData] = await Promise.all([
      fetchAndParseCsv('./部屋名_読み付き.csv', 3),
      fetchAndParseCsv('./劣化項目_読み付き.csv', 3)
    ]);
    console.log(`Loaded ${locationPredictions.length} location predictions.`);
    console.log(`Loaded ${degradationItemsData.length} degradation items.`);
    // console.log("Sample degradationItemsData:", degradationItemsData.slice(0, 5));
  } catch (error) {
    console.error("Critical error loading prediction data:", error);
    alert("予測変換データの読み込みに失敗しました。");
  }
}

// ======================================================================
// 6. Prediction Logic Functions
// ======================================================================
function generateLocationPredictions(inputText) {
    // console.log(`[generateLocationPredictions] Input: \"${inputText}\"`);
    const inputTextTrimmed = inputText.trim();
    if (!inputTextTrimmed) return [];

    const inputTextHankaku = zenkakuToHankaku(inputTextTrimmed);
    // console.log(`[generateLocationPredictions] Input after Hankaku: \"${inputTextHankaku}\"`);

  let floorSearchTerm = null;
  let roomSearchTermRaw = inputTextHankaku;
  let roomSearchTermHiragana = '';

    // シンプルな階数プレフィックス抽出 (例: 数字 or 英字1-3文字 + F/f(任意))
    const floorMatch = roomSearchTermRaw.match(/^([a-zA-Z0-9]{1,3}[fF]?)(.*)$/);

    if (floorMatch && floorMatch[1]) {
        // 抽出したプレフィックスを階数検索タームとする
    floorSearchTerm = floorMatch[1].toLowerCase();
        // 残りを部屋名検索タームとする（先頭のスペースは除去）
        roomSearchTermRaw = floorMatch[2] ? floorMatch[2].trim() : '';
        // console.log(`[generateLocationPredictions] Floor detected: '${floorSearchTerm}', Room term: '${roomSearchTermRaw}'`);
  } else {
        // 階数プレフィックスが見つからなければ、入力全体を部屋名検索タームとする
        roomSearchTermRaw = inputTextHankaku;
        // console.log(`[generateLocationPredictions] No floor prefix detected, treating as room term: '${roomSearchTermRaw}'`);
  }

  roomSearchTermHiragana = katakanaToHiragana(roomSearchTermRaw.toLowerCase());

    // 検索タームがなければ空配列を返す
    if (!floorSearchTerm && !roomSearchTermHiragana) {
      // console.log("[generateLocationPredictions] No valid search term after processing.");
      return [];
  }

    let candidateFloors = new Set();
    let candidateRooms = new Set();
    let directMatches = new Set(); // 入力に完全一致する可能性のある候補

    locationPredictions.forEach(item => {
        const itemFloor = item.floor || '';
        const itemFloorLower = itemFloor.toLowerCase();
        const itemValue = item.value || ''; // 部屋名
        const itemValueLower = itemValue.toLowerCase();
      const itemReadingHiragana = katakanaToHiragana(item.reading?.toLowerCase() || '');
        const combinedLocation = `${itemFloor} ${itemValue}`.trim(); // 組み合わせた文字列

        // --- 候補の収集 ---
        // 1. 階数検索タームがある場合、前方一致する階数を候補に追加
        if (floorSearchTerm && itemFloorLower.startsWith(floorSearchTerm)) {
            candidateFloors.add(itemFloor);
        }

        // 2. 部屋名検索タームがある場合、名称または読みが前方一致する部屋名を候補に追加
        if (roomSearchTermHiragana && (itemValueLower.startsWith(roomSearchTermRaw.toLowerCase()) || itemReadingHiragana.startsWith(roomSearchTermHiragana))) {
             candidateRooms.add(itemValue);
        }

        // 3. 入力文字列が、CSV内の「階数 部屋名」の組み合わせに前方一致するかチェック
        if (combinedLocation.toLowerCase().startsWith(inputTextHankaku.toLowerCase())) {
             directMatches.add(combinedLocation);
        }
        // 4. 入力文字列が、CSV内の部屋名のみに前方一致するかチェック (階数がないデータ用)
        else if (!itemFloor && itemValueLower.startsWith(inputTextHankaku.toLowerCase())) {
             directMatches.add(itemValue);
        }

    });

    let finalPredictions = new Set(directMatches); // まず直接一致したものを優先

    // --- 組み合わせ生成 ---
    const floorArray = Array.from(candidateFloors);
    const roomArray = Array.from(candidateRooms);

    // A. 階数と部屋名の両方が入力されている場合 -> 候補の組み合わせを追加
    if (floorSearchTerm && roomSearchTermHiragana) {
        floorArray.forEach(floor => {
            roomArray.forEach(room => {
                 // ★ 修正: exists チェックを削除し、単純に組み合わせる
                 // const exists = locationPredictions.some(p => p.floor === floor && p.value === room);
                 // if (exists) {
                 finalPredictions.add(`${floor} ${room}`);
                 // }
            });
        });
    }
    // B. 階数のみ入力されている場合 -> 「階数」自体と「階数 + 候補部屋名」を追加
    else if (floorSearchTerm) {
        floorArray.forEach(floor => {
             finalPredictions.add(floor); // 階数自体
             // その階数に紐づく部屋名をCSVから取得して組み合わせる
             locationPredictions.forEach(p => {
                 if (p.floor === floor && p.value) {
                      finalPredictions.add(`${floor} ${p.value}`);
                 }
             });
        });
    }
    // C. 部屋名のみ入力されている場合 -> 「部屋名」自体と「候補階数 + 部屋名」を追加
    else if (roomSearchTermHiragana) {
         roomArray.forEach(room => {
             finalPredictions.add(room); // 部屋名自体
             // その部屋名に紐づく階数をCSVから取得して組み合わせる
             locationPredictions.forEach(p => {
                  if (p.value === room && p.floor) {
                      finalPredictions.add(`${p.floor} ${room}`);
                  }
             });
         });
    }

    // console.log(`[generateLocationPredictions] Generated ${finalPredictions.size} unique predictions.`);
    // 制限して返す
    return Array.from(finalPredictions).slice(0, 10);
}


function generateDegradationPredictions(inputText) {
  // console.log(`[generateDegradationPredictions] Input: \"${inputText}\"`);
  if (!inputText || inputText.trim().length < 1) {
    return [];
  }
  const searchTermLower = inputText.trim().toLowerCase();
  const searchTermHiragana = katakanaToHiragana(searchTermLower);
  const isTwoCharInput = searchTermHiragana.length === 2;

  let readingPrefixMatches = new Set();
  let nameMatches = new Set();
  let codeMatches = new Set();

  degradationItemsData.forEach(item => {
    if (!item || !item.name) return; // Skip invalid items

    const itemNameLower = item.name.toLowerCase();
    const itemReadingRaw = item.reading || ''; 
    const itemCodeHiragana = katakanaToHiragana(item.code?.toLowerCase() || '');

    // 1. Reading prefix match
    const readingParts = itemReadingRaw.split(' ');
    let isReadingPrefixMatch = false;
    for (const part of readingParts) {
      const partHiragana = katakanaToHiragana(part.toLowerCase());
      if (partHiragana.startsWith(searchTermHiragana)) {
        readingPrefixMatches.add(item.name);
        isReadingPrefixMatch = true;
        break; // Stop checking parts for this item once matched
      }
    }

    // 2. Name contains match (only if not matched by reading)
    if (!isReadingPrefixMatch && itemNameLower.includes(searchTermLower)) {
      nameMatches.add(item.name);
    }

    // 3. Two-char code exact match (only if not matched by reading or name)
    if (!isReadingPrefixMatch && !itemNameLower.includes(searchTermLower) && 
        isTwoCharInput && itemCodeHiragana && itemCodeHiragana === searchTermHiragana) {
      codeMatches.add(item.name);
    }
  });

  // Combine with priority: Reading > Name > Code
  const combined = [...readingPrefixMatches, ...nameMatches, ...codeMatches];
  // Ensure uniqueness while preserving the priority order
  const uniquePredictions = Array.from(new Set(combined));

  // console.log(`[generateDegradationPredictions] Returning ${uniquePredictions.length} predictions:`, uniquePredictions.slice(0, 10));
  return uniquePredictions.slice(0, 10);
}


// ======================================================================
// 7. UI Update Functions
// ======================================================================
function showPredictions(inputElement, predictionListElement, predictions) {
  if (!inputElement || !predictionListElement) return;
  predictionListElement.innerHTML = '';

  if (predictions.length > 0) {
    predictions.forEach(prediction => {
      const li = document.createElement('li');
      li.textContent = prediction;
      li.setAttribute('tabindex', '-1'); // Make it focusable but not tabbable
      li.classList.add('px-3', 'py-1', 'cursor-pointer', 'hover:bg-blue-100', 'list-none', 'text-sm');

      const selectPrediction = (event) => {
        event.preventDefault(); // Prevent default behavior (like blur on touch)
        inputElement.value = prediction;
        hidePredictions(predictionListElement);

        // Determine next element to focus
        let nextFocusElementId = null;
        if (inputElement.id === 'locationInput') {
          nextFocusElementId = 'deteriorationNameInput';
        } else if (inputElement.id === 'deteriorationNameInput') {
          nextFocusElementId = 'submitDeteriorationBtn'; // Focus submit button
        } else if (inputElement.id === 'editLocationInput') {
          nextFocusElementId = 'editDeteriorationNameInput';
        } else if (inputElement.id === 'editDeteriorationNameInput') {
          nextFocusElementId = 'editSubmitBtn'; // Focus edit submit button
        }

        if (nextFocusElementId) {
          const nextElement = document.getElementById(nextFocusElementId);
          if (nextElement) {
            // Use setTimeout to ensure focus happens after other event processing
          setTimeout(() => {
                 nextElement.focus();
                 // For buttons, sometimes triggering click is also useful
                 // if(nextElement.tagName === 'BUTTON') nextElement.click();
          }, 0);
        }
        }
      };

      // Use 'mousedown'/'touchstart' instead of 'click' to prevent blur before selection
      li.addEventListener('mousedown', selectPrediction);
      li.addEventListener('touchstart', selectPrediction, { passive: false }); // Need passive: false to preventDefault

      predictionListElement.appendChild(li);
    });
    predictionListElement.classList.remove('hidden');
  } else {
    hidePredictions(predictionListElement);
  }
}


function hidePredictions(predictionListElement) {
  if (predictionListElement) {
  predictionListElement.classList.add('hidden');
  }
}

function setupPredictionListeners(inputElement, predictionListElement, generatorFn, nextElementId) {
  if (!inputElement || !predictionListElement) {
      console.warn("setupPredictionListeners: Input or List element not found.");
      return;
  }

  inputElement.addEventListener('input', () => {
    const inputText = inputElement.value;
        const predictions = generatorFn(inputText);
        showPredictions(inputElement, predictionListElement, predictions);
  });

  // Hide predictions on blur, but with a delay to allow clicking on prediction items
  inputElement.addEventListener('blur', () => {
    // Use setTimeout to allow click event on prediction list items to fire first
    setTimeout(() => hidePredictions(predictionListElement), 200);
  });

  // Show predictions on focus if input is not empty
  inputElement.addEventListener('focus', () => {
    const inputText = inputElement.value;
    if (inputText.trim()) {
      const predictions = generatorFn(inputText);
      if (predictions.length > 0) {
          showPredictions(inputElement, predictionListElement, predictions);
      }
    }
  });

  // Handle Enter key press for focus navigation
  if (nextElementId) {
    inputElement.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault(); // Prevent form submission if inside a form
        hidePredictions(predictionListElement);
        const nextElement = document.getElementById(nextElementId);
        if (nextElement) {
          nextElement.focus();
        }
      }
    });
  }
}

function switchTab(activeTabId, infoTabBtn, detailTabBtn, infoTab, detailTab) {
  if (!infoTabBtn || !detailTabBtn || !infoTab || !detailTab) return;
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
  localStorage.setItem('lastActiveTabId', activeTabId);
  // console.log(`[switchTab] Switched to ${activeTabId} and saved state.`);
}

async function updateNextIdDisplay(projectId, buildingId, nextIdDisplayElement) {
  if (!nextIdDisplayElement) return;
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

// ★ 修正: 引数から editPhotoNumberInput を削除
function renderDeteriorationTable(recordsToRender, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */) {
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
        // ★ 修正: photoNumber を表示する列はそのまま (データは自動採番されたもの)
        tr.innerHTML = `
            <td class="py-1 px-2 text-center text-sm">${escapeHtml(record.number)}</td>
            <td class="py-1 px-2 text-sm">
                <div class="cell-truncate" title="${escapeHtml(record.location)}">
                    ${escapeHtml(record.location)}
                </div>
            </td>
            <td class="py-1 px-2 text-sm">
                <div class="cell-truncate" title="${escapeHtml(record.name)}">
                    ${escapeHtml(record.name)}
                </div>
            </td>
            <td class="py-1 px-2 text-center text-sm">${escapeHtml(record.photoNumber)}</td>
            <td class="py-1 px-1 text-center whitespace-nowrap">
                <button class="edit-btn bg-green-500 hover:bg-green-600 text-white py-1 px-2 rounded text-xs mr-1">編集</button>
                <button class="delete-btn bg-red-500 hover:bg-red-600 text-white py-1 px-2 rounded text-xs">削除</button>
            </td>
        `;
        // Add event listeners for edit and delete buttons
        const editBtn = tr.querySelector('.edit-btn');
        const deleteBtn = tr.querySelector('.delete-btn');
        if (editBtn) {
            // ★ 修正: handleEditClick 呼び出し修正
            editBtn.addEventListener('click', () => handleEditClick(currentProjectId, currentBuildingId, record.id, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */));
        }
        if (deleteBtn) {
            // ★ 修正: handleDeleteClick 呼び出し修正
            deleteBtn.addEventListener('click', () => handleDeleteClick(currentProjectId, currentBuildingId, record.id, record.number));
        }
        deteriorationTableBodyElement.appendChild(tr);
    });
}


// ======================================================================
// 8. Data Loading - Building List & Deteriorations
// ======================================================================
// ★ 修正: 引数から editPhotoNumberInput を削除
async function updateBuildingSelectorForProject(projectId, buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */, buildingIdToSelect = null) {
  if (!buildingSelectElement || !activeBuildingNameSpanElement || !nextIdDisplayElement || !deteriorationTableBodyElement || !editModalElement || !editIdDisplay || !editLocationInput || !editDeteriorationNameInput) {
    console.error("[updateBuildingSelectorForProject] Missing one or more required UI elements.");
    return;
  }

  if (!projectId) {
    console.warn("[updateBuildingSelectorForProject] No projectId provided.");
    buildingSelectElement.innerHTML = '<option value="">-- 現場を先に選択 --</option>';
    buildingSelectElement.disabled = true;
    activeBuildingNameSpanElement.textContent = '未選択';
    // ★ 修正: renderDeteriorationTable 呼び出し修正
    renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */);
    updateNextIdDisplay(null, null, nextIdDisplayElement);
    currentBuildingId = null;
    return;
  }
  console.log(`[updateBuildingSelectorForProject] Updating buildings for project ${projectId}`);
  const buildingsRef = getBuildingsRef(projectId);
  buildingSelectElement.innerHTML = '<option value="">読み込み中...</option>';
  buildingSelectElement.disabled = true;

  try {
    // console.log(`[updateBuildingSelectorForProject] Attempting to fetch buildings from Firebase for ${projectId}`);
    const snapshot = await buildingsRef.once('value');
    // console.log(`[updateBuildingSelectorForProject] Firebase snapshot received. Exists: ${snapshot.exists()}`);
    const buildingsData = snapshot.val();
    // console.log(`[updateBuildingSelectorForProject] Raw buildingsData:`, buildingsData);

    const buildingEntries = buildingsData ? Object.entries(buildingsData) : [];
    // console.log(`[updateBuildingSelectorForProject] Processed buildingEntries count: ${buildingEntries.length}`);

    if (buildingEntries.length > 0) {
      // console.log('[updateBuildingSelectorForProject] Building entries found. Populating selector...');
      buildingSelectElement.innerHTML = '<option value="">-- 建物を選択 --</option>';
      // Sort: site first, then by name
      buildingEntries.sort(([idA, dataA], [idB, dataB]) => {
          if (idA === 'site') return -1;
          if (idB === 'site') return 1;
          const nameA = dataA.name || '';
          const nameB = dataB.name || '';
          return nameA.localeCompare(nameB, 'ja');
      });
      // console.log('[updateBuildingSelectorForProject] Buildings sorted.');
      
      buildingEntries.forEach(([buildingId, buildingData]) => {
        try {
          const option = document.createElement('option');
          option.value = buildingId;
          option.textContent = buildingData?.name || `建物 (${buildingId})`; 
          buildingSelectElement.appendChild(option);
        } catch(loopError) {
            console.error(`[updateBuildingSelectorForProject] Error adding option for building ID=${buildingId}:`, loopError);
        }
      });
      buildingSelectElement.disabled = false;
      // console.log('[updateBuildingSelectorForProject] Selector populated and enabled.');

      let selectedBuildingId = null;
      // console.log(`[updateBuildingSelectorForProject] Determining selection. Hint: ${buildingIdToSelect}, Current: ${currentBuildingId}, Last used: ${lastUsedBuilding}`);
      if (buildingIdToSelect && buildingSelectElement.querySelector(`option[value="${buildingIdToSelect}"]`)) {
          selectedBuildingId = buildingIdToSelect;
          // console.log(`[updateBuildingSelectorForProject] Selecting specified building: ${selectedBuildingId}`);
      } else if (currentBuildingId && buildingSelectElement.querySelector(`option[value="${currentBuildingId}"]`)) {
          selectedBuildingId = currentBuildingId;
          // console.log(`[updateBuildingSelectorForProject] Maintaining current building: ${selectedBuildingId}`);
      } else if (lastUsedBuilding && buildingSelectElement.querySelector(`option[value="${lastUsedBuilding}"]`)) {
          selectedBuildingId = lastUsedBuilding;
          // console.log(`[updateBuildingSelectorForProject] Restoring last used building: ${selectedBuildingId}`);
      } else {
          // Fallback to 'site' if it exists, otherwise the first non-empty option
          const siteOption = buildingSelectElement.querySelector('option[value="site"]');
          if (siteOption) {
              selectedBuildingId = 'site';
              // console.log('[updateBuildingSelectorForProject] Selecting "site" as fallback.');
      } else {
          const firstOption = buildingSelectElement.querySelector('option:not([value=""])');
          if (firstOption) {
              selectedBuildingId = firstOption.value;
                  // console.log(`[updateBuildingSelectorForProject] Selecting first available building: ${selectedBuildingId}`);
          }
      }
      }
      // console.log(`[updateBuildingSelectorForProject] Final selectedBuildingId: ${selectedBuildingId}`);
      
      if (selectedBuildingId) {
          buildingSelectElement.value = selectedBuildingId;
          currentBuildingId = selectedBuildingId;
          lastUsedBuilding = selectedBuildingId; 
          localStorage.setItem('lastBuildingId', currentBuildingId);
          activeBuildingNameSpanElement.textContent = buildingSelectElement.options[buildingSelectElement.selectedIndex]?.text || '不明';
          // ★ 修正: fetchAndRenderDeteriorations 呼び出し修正
          await fetchAndRenderDeteriorations(projectId, currentBuildingId, deteriorationTableBodyElement, nextIdDisplayElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */);
      } else {
          console.log('[updateBuildingSelectorForProject] No building could be selected.');
          activeBuildingNameSpanElement.textContent = '未選択';
          // ★ 修正: renderDeteriorationTable 呼び出し修正
          renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */);
          updateNextIdDisplay(projectId, null, nextIdDisplayElement);
          currentBuildingId = null;
      }
      
    } else {
      console.log('[updateBuildingSelectorForProject] No building entries found after fetch.');
      buildingSelectElement.innerHTML = '<option value="">-- 建物未登録 --</option>';
      activeBuildingNameSpanElement.textContent = '未登録';
      // ★ 修正: renderDeteriorationTable 呼び出し修正
      renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */);
      updateNextIdDisplay(projectId, null, nextIdDisplayElement);
      currentBuildingId = null;
    }
  } catch (error) {
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("[updateBuildingSelectorForProject] <<<< CATCH BLOCK EXECUTED >>>>");
    console.error(`[updateBuildingSelectorForProject] <<<< ERROR >>>> Error fetching/processing buildings for project ${projectId}:`);
    console.error("Error Object:", error);
    buildingSelectElement.innerHTML = '<option value="">読み込みエラー</option>';
    activeBuildingNameSpanElement.textContent = 'エラー';
    // ★ 修正: renderDeteriorationTable 呼び出し修正
    renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */);
    updateNextIdDisplay(null, null, nextIdDisplayElement);
    currentBuildingId = null;
  }
}


// ======================================================================
// 9. Basic Info & Project List Management
// ======================================================================
async function loadBasicInfo(projectId, siteNameInput) { 
  if (!siteNameInput) return;
  console.log(`[loadBasicInfo] Loading basic info for project ID: ${projectId}`);
  const infoRef = getProjectInfoRef(projectId);
  try {
    const snapshot = await infoRef.once('value');
    const info = snapshot.val();
    if (info && info.siteName) {
      // console.log("[loadBasicInfo] Found info:", info);
      siteNameInput.value = info.siteName;
    } else {
      console.log("[loadBasicInfo] No info or siteName found for this project.");
      // Keep existing input value if no info found? Or clear it? Let's clear.
      // siteNameInput.value = ''; // Or keep if user might be typing new name
    }
  } catch (error) {
    console.error("Error loading basic info:", error);
    // siteNameInput.value = ''; // Clear on error
  }
}

const MAX_RECENT_PROJECTS = 10;
const RECENT_PROJECTS_KEY = 'recentProjectNames';

function getRecentProjectNames() {
  try {
    const stored = localStorage.getItem(RECENT_PROJECTS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (e) {
    console.error("Error reading recent projects from localStorage:", e);
    localStorage.removeItem(RECENT_PROJECTS_KEY); // Clear corrupted data
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
    // console.log(`[addProjectToRecentList] Updated recent projects:`, recentNames);
  } catch (e) {
    console.error("Error saving recent projects to localStorage:", e);
  }
}

function updateDatalistWithOptions(allProjectNames, projectDataListElement) {
  if (!projectDataListElement) return;

  const recentNames = getRecentProjectNames();
  const recentSet = new Set(recentNames);

  // Ensure allProjectNames is an array of unique names
  const uniqueAllProjectNames = [...new Set(allProjectNames)];

  // Separate recent names present in allProjectNames and other names
  const validRecentNames = recentNames.filter(name => uniqueAllProjectNames.includes(name));
  const otherNames = uniqueAllProjectNames
    .filter(name => !recentSet.has(name))
    .sort((a, b) => a.localeCompare(b, 'ja')); // Sort remaining names alphabetically (Japanese)

  // Combine: valid recent first, then others. Ensure uniqueness again.
  const finalSortedNames = [...new Set([...validRecentNames, ...otherNames])];

  projectDataListElement.innerHTML = ''; // Clear existing options
  finalSortedNames.forEach(projectName => {
    const option = document.createElement('option');
    option.value = projectName;
    projectDataListElement.appendChild(option);
  });
  // console.log("[updateDatalistWithOptions] Datalist updated.");
}

async function populateProjectDataList(projectDataListElement) {
  // console.log("[populateProjectDataList] Populating project data list...");
  const CACHE_KEY = 'projectDataListCache';
  const CACHE_EXPIRY = 30 * 1000; // 5 minutes cache -> 30秒に短縮

  try {
    const cachedData = localStorage.getItem(CACHE_KEY);
    if (cachedData) {
      const { timestamp, data } = JSON.parse(cachedData);
      if (Date.now() - timestamp < CACHE_EXPIRY) {
        // console.log("[populateProjectDataList] Using cached project list.");
        return data || []; // Return cached unique data
      }
    }
  } catch (e) {
    console.error("Error reading project list cache:", e);
    localStorage.removeItem(CACHE_KEY); // Clear corrupted cache
  }

  console.log("[populateProjectDataList] Cache invalid/missing, fetching fresh list from Firebase.");
  try {
    const snapshot = await database.ref('projects').orderByChild('info/siteName').once('value');
    const projects = snapshot.val();
    let projectNames = [];
    if (projects) {
      projectNames = Object.values(projects)
                         .map(proj => proj?.info?.siteName)
                         .filter(name => name); // Extract valid names
    }
    const uniqueProjectNames = [...new Set(projectNames)]; // Ensure uniqueness

    // Store fresh unique data in cache
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), data: uniqueProjectNames }));
      // console.log("[populateProjectDataList] Fetched and cached unique project list.");
    } catch (e) {
      console.error("Error saving project list cache:", e);
    }
    return uniqueProjectNames;
  } catch (error) {
    console.error("Error fetching project list from Firebase:", error);
    alert("現場リストの読み込みに失敗しました。");
    return []; // Return empty list on error
  }
}

// 新規追加時のキャッシュクリア関数を追加
function clearProjectListCache() {
  localStorage.removeItem('projectDataListCache');
  console.log("[clearProjectListCache] Project list cache cleared.");
}

// ======================================================================
// 10. Data Manipulation - Counters & Number Generation
// ======================================================================
async function getNextDeteriorationNumber(projectId, buildingId) {
  if (!projectId || !buildingId) {
      console.warn("[getNextDeteriorationNumber] Missing projectId or buildingId.");
      return 1; // Default to 1
  }
  const counterRef = getDeteriorationCounterRef(projectId, buildingId);
  let nextNumber = 1;
  try {
      const result = await counterRef.transaction(currentCounter => {
          return (currentCounter || 0) + 1;
      });

      if (result.committed && result.snapshot.exists()) {
          nextNumber = result.snapshot.val();
          // console.log(`[getNextDeteriorationNumber] Next number: ${nextNumber} for ${projectId}/${buildingId}`);
      } else {
          console.warn("[getNextDeteriorationNumber] Transaction failed. Reading directly.");
          const fallbackSnapshot = await counterRef.once('value');
          nextNumber = (fallbackSnapshot.val() || 0) + 1; 
      }
  } catch (error) {
      console.error("Error getting next deterioration number (transaction):", error);
      try { // Fallback read on error
        const snapshot = await counterRef.once('value');
        nextNumber = (snapshot.val() || 0) + 1;
      } catch (readError) {
          console.error("Fallback read also failed:", readError);
          nextNumber = 1; // Ultimate fallback
      }
  }
  return nextNumber;
}

// ★ 修正: getNextPhotoNumber 関数 (新しいロジック)
async function getNextPhotoNumber(projectId, buildingId) {
    if (!projectId || !buildingId) {
        console.warn("[getNextPhotoNumber] Missing projectId or buildingId.");
        return '0000'; // Default or error value
    }
    const counterRef = getPhotoCounterRef(projectId, buildingId);
    const offset = getBuildingPhotoOffset(buildingId); // Get building-specific offset
    let nextLocalCounter = 1; // Counter within the building (starts from 1)

    try {
        const result = await counterRef.transaction(currentCounter => {
            // Increment the counter, starting from 0 if it doesn't exist
            return (currentCounter || 0) + 1;
        });

        if (result.committed && result.snapshot.exists()) {
            nextLocalCounter = result.snapshot.val();
            // console.log(`[getNextPhotoNumber] Next local counter: ${nextLocalCounter} for ${projectId}/${buildingId}`);
        } else {
            console.warn("[getNextPhotoNumber] Transaction failed. Reading directly.");
            const fallbackSnapshot = await counterRef.once('value');
            // If fallback read fails, nextLocalCounter remains 1
            nextLocalCounter = (fallbackSnapshot.val() || 0) + 1;
        }
    } catch (error) {
        console.error("[getNextPhotoNumber] Error in transaction:", error);
        try { // Fallback read on transaction error
            const snapshot = await counterRef.once('value');
            nextLocalCounter = (snapshot.val() || 0) + 1;
        } catch (readError) {
            console.error("[getNextPhotoNumber] Fallback read also failed:", readError);
            nextLocalCounter = 1; // Ultimate fallback
        }
    }

    // Calculate the final photo number by adding the offset to the local counter
    // Ensure the local counter doesn't exceed 999 for a 4-digit format with offset
    const finalPhotoNumber = offset + Math.min(nextLocalCounter, 999);

    if (nextLocalCounter > 999) {
        console.warn(`[getNextPhotoNumber] Local counter ${nextLocalCounter} exceeded 999 for offset ${offset}. Capped at ${finalPhotoNumber}. Building: ${buildingId}`);
        // Consider logging this more permanently or alerting the user if necessary
    }

    return finalPhotoNumber.toString().padStart(4, '0');
}

// ======================================================================
// 11. Event Handlers - Deterioration Form
// ======================================================================
// ★ 修正: recordLastAddedData 関数 (写真番号を除去)
function recordLastAddedData(location, name) {
    lastAddedLocation = location;
    lastAddedName = name;
    // console.log(`[recordLastAddedData] Recorded last added: Location="${lastAddedLocation}", Name="${lastAddedName}"`);
}

// ★ 修正: handleDeteriorationSubmit 関数
async function handleDeteriorationSubmit(event, locationInput, deteriorationNameInput, /* ★削除 */ nextIdDisplayElement, locationPredictionsElement) {
  if (!locationInput || !deteriorationNameInput || !nextIdDisplayElement || !locationPredictionsElement) {
      console.error("[handleDeteriorationSubmit] Missing required UI elements.");
      alert("内部エラー: UI要素が見つかりません。");
      return;
  }
  event.preventDefault();
  const location = locationInput.value.trim();
  const deteriorationName = deteriorationNameInput.value.trim();

  if (!location || !deteriorationName) {
    alert("場所と劣化名を入力してください。");
    return;
  }

  if (!currentProjectId || !currentBuildingId) {
    alert("現場名または建物名が選択されていません。");
    return;
  }

  console.log(`[handleDeteriorationSubmit] Submitting for ${currentProjectId}/${currentBuildingId}`);

  try {
    // Get next deterioration number and photo number in parallel
    const [nextNumber, newPhotoNumber] = await Promise.all([
        getNextDeteriorationNumber(currentProjectId, currentBuildingId),
        getNextPhotoNumber(currentProjectId, currentBuildingId)
    ]);

    const deteriorationData = {
      number: nextNumber, 
      location: location,
      name: deteriorationName,
      photoNumber: newPhotoNumber, // Use auto-generated photo number
      createdAt: firebase.database.ServerValue.TIMESTAMP
    };

    const deteriorationRef = getDeteriorationsRef(currentProjectId, currentBuildingId);
    await deteriorationRef.push(deteriorationData);

    console.log("[handleDeteriorationSubmit] Submitted successfully.");
    hidePredictions(locationPredictionsElement); 
    locationInput.value = '';
    deteriorationNameInput.value = '';
    // Photo number input is removed
    updateNextIdDisplay(currentProjectId, currentBuildingId, nextIdDisplayElement);
    recordLastAddedData(location, deteriorationName); // Record data for continuous add
    locationInput.focus(); // Focus back on location input

  } catch (error) {
      console.error("[handleDeteriorationSubmit] Error:", error);
      alert("情報の保存中にエラーが発生しました: " + error.message);
  }
}

// ★ 修正: handleContinuousAdd 関数
async function handleContinuousAdd(nextIdDisplayElement, locationInput) {
  if (!nextIdDisplayElement || !locationInput) {
    console.error("[handleContinuousAdd] Missing required UI elements.");
    alert("内部エラー: UI要素が見つかりません。");
    return;
  }
  const location = lastAddedLocation;
  const deteriorationName = lastAddedName;

  if (!currentProjectId || !currentBuildingId) {
    alert("現場と建物が選択されていません。");
    return;
  }
  if (!location || !deteriorationName) {
    alert("連続登録する情報がありません。\n（直前に登録した場所・劣化名が使用されます）");
    return;
  }

  console.log(`[handleContinuousAdd] Submitting continuous for ${currentProjectId}/${currentBuildingId}`);

  try {
    // Get next deterioration number and photo number in parallel
    const [nextNumber, newPhotoNumber] = await Promise.all([
        getNextDeteriorationNumber(currentProjectId, currentBuildingId),
        getNextPhotoNumber(currentProjectId, currentBuildingId)
    ]);
    
    const deteriorationData = {
      number: nextNumber, 
      location: location, // Use last added location
      name: deteriorationName, // Use last added name
      photoNumber: newPhotoNumber, // Use auto-generated photo number
      createdAt: firebase.database.ServerValue.TIMESTAMP
    };

    const deteriorationRef = getDeteriorationsRef(currentProjectId, currentBuildingId);
    await deteriorationRef.push(deteriorationData);

    console.log("[handleContinuousAdd] Submitted successfully.");
    // Don't clear inputs here, keep them for reference if needed
    updateNextIdDisplay(currentProjectId, currentBuildingId, nextIdDisplayElement);
    recordLastAddedData(location, deteriorationName); // Re-record in case needed again
    locationInput.focus(); // Focus back on location input

  } catch (error) {
    console.error("[handleContinuousAdd] Error:", error);
    alert("連続登録中にエラーが発生しました: " + error.message);
  }
}

// ======================================================================
// 12. Event Handlers - Edit Modal
// ======================================================================
// ★ 修正: handleEditClick 関数
async function handleEditClick(projectId, buildingId, recordId, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */) {
  if (!editModalElement || !editIdDisplay || !editLocationInput || !editDeteriorationNameInput) {
      console.error("[handleEditClick] Missing required edit modal UI elements.");
      alert("内部エラー: 編集モーダルのUI要素が見つかりません。");
      return;
  }
  console.log(`[handleEditClick] Editing record: ${recordId} in ${projectId}/${buildingId}`);
  currentEditRecordId = recordId;

  const recordRef = getDeteriorationsRef(projectId, buildingId).child(recordId);
  try {
    const snapshot = await recordRef.once('value');
    const recordData = snapshot.val();

    if (recordData) {
      editIdDisplay.textContent = recordData.number || '';
      editLocationInput.value = recordData.location || '';
      editDeteriorationNameInput.value = recordData.name || '';
      // Photo number display/edit is removed

      editModalElement.classList.remove('hidden');
    } else {
      console.error(`[handleEditClick] Record data not found for ID: ${recordId}`);
      alert("編集対象のデータが見つかりませんでした。");
      currentEditRecordId = null; // Reset ID if data not found
    }
  } catch (error) {
    console.error("[handleEditClick] Error fetching record data:", error);
    alert("編集データの取得中にエラーが発生しました: " + error.message);
    currentEditRecordId = null; // Reset ID on error
  }
}

// ★ 修正: handleDeleteClick 関数
function handleDeleteClick(projectId, buildingId, recordId, recordNumber) {
  if (!projectId || !buildingId || !recordId) {
      console.error("[handleDeleteClick] Missing IDs for deletion.");
      return;
  }
  console.log(`[handleDeleteClick] Deleting record ID: ${recordId} (Number: ${recordNumber}) in ${projectId}/${buildingId}`);

  const confirmation = confirm(`レコード ${recordNumber} を削除してもよろしいですか？\nこの操作は元に戻せません。`);
  if (confirmation) {
    const deteriorationRef = getDeteriorationsRef(projectId, buildingId).child(recordId);
    deteriorationRef.remove()
      .then(() => {
        console.log(`[handleDeleteClick] Record ${recordId} deleted successfully.`);
        // Optionally update UI elements if needed, e.g., the next ID display,
        // but the listener should handle the table re-render automatically.
        const nextIdDisplayElement = document.getElementById('nextIdDisplay');
        if (nextIdDisplayElement) {
        updateNextIdDisplay(projectId, buildingId, nextIdDisplayElement);
        }
      })
      .catch(error => {
        console.error("[handleDeleteClick] Error deleting record:", error);
        alert("レコードの削除中にエラーが発生しました: " + error.message);
      });
  }
}

// ★ 修正: handleEditSubmit 関数
function handleEditSubmit(event, editIdDisplay, editLocationInput, editDeteriorationNameInput, /* ★削除 */ editModalElement) {
  if (!editIdDisplay || !editLocationInput || !editDeteriorationNameInput || !editModalElement) {
      console.error("[handleEditSubmit] Missing required edit modal UI elements.");
      alert("内部エラー: 編集モーダルのUI要素が見つかりません。");
      return;
  }
  event.preventDefault();
  const recordId = currentEditRecordId;
  const location = editLocationInput.value.trim();
  const deteriorationName = editDeteriorationNameInput.value.trim();

  if (!recordId) {
    alert("編集対象のレコードIDが見つかりません。");
    return;
  }
  if (!location || !deteriorationName) {
    alert("場所と劣化名を入力してください。");
    return;
  }

  const projectId = currentProjectId;
  const buildingId = currentBuildingId;

  if (!projectId || !buildingId) {
    alert("現在の現場名または建物名が不明です。");
    return;
  }

  console.log(`[handleEditSubmit] Submitting edit for record ID: ${recordId} in ${projectId}/${buildingId}`);

  // Only update location, name, and timestamp. Photo number is not editable.
  const deteriorationUpdateData = {
    location: location,
    name: deteriorationName,
    // photoNumber: photoNumber, // ★ 削除
    lastUpdatedAt: firebase.database.ServerValue.TIMESTAMP
  };

  const deteriorationRef = getDeteriorationsRef(projectId, buildingId).child(recordId);
  deteriorationRef.update(deteriorationUpdateData)
    .then(() => {
      console.log("[handleEditSubmit] Record updated successfully.");
      editModalElement.classList.add('hidden');
      currentEditRecordId = null; // Clear edit ID after successful submission
    })
    .catch(error => {
      console.error("[handleEditSubmit] Error updating record:", error);
      alert("情報の保存中にエラーが発生しました: " + error.message);
      // Keep modal open and ID set on error? Maybe.
    });
}

// ======================================================================
// 13. Event Handlers - Export & Other
// ======================================================================
// ★ 修正: handleExportCsv 関数 (photoNumber の扱いは変更なし、ファイル名修正)
function handleExportCsv(siteNameInput, buildingSelectElement) {
  if (!siteNameInput || !buildingSelectElement) {
      console.error("[handleExportCsv] Missing siteNameInput or buildingSelectElement.");
      return;
  }
  const siteName = siteNameInput.value.trim();
  const buildingId = buildingSelectElement.value; // Use selected value (building ID)

  if (!siteName || !buildingId) {
    alert("現場と建物を選択してください。");
    return;
  }

  const projectId = generateProjectId(siteName);
  // No need to generate buildingId, it's already selected

  if (!projectId) {
    alert("現場名が無効です。");
    return;
  }

  console.log(`[handleExportCsv] Exporting CSV for project: ${projectId}, building: ${buildingId}`);

  const deteriorationRef = getDeteriorationsRef(projectId, buildingId);
  deteriorationRef.orderByChild('number').once('value', (snapshot) => { // Order by number
    const data = snapshot.val();
    let deteriorations = [];
    if (data) {
      // Convert object to array and keep original keys if needed
      deteriorations = Object.entries(data).map(([id, deterioration]) => ({
        id, // Keep the Firebase key
        ...deterioration
      }));
      // Sorting is now done by Firebase query (orderByChild)
      // deteriorations.sort((a, b) => a.number - b.number);
    } else {
        console.log("[handleExportCsv] No data found to export.");
        alert("エクスポートするデータがありません。");
        return;
    }

    const csvHeader = ['番号', '場所', '劣化名', '写真番号', '登録日時']; // Include timestamp

    const csvRows = deteriorations.map(deterioration => {
        let formattedDate = '';
        if (deterioration.createdAt) {
            try {
            const date = new Date(deterioration.createdAt);
                if (!isNaN(date)) { // Check if date is valid
            const pad = (num) => num.toString().padStart(2, '0');
            formattedDate = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
                } else {
                    formattedDate = 'Invalid Date';
                }
            } catch (e) {
                 formattedDate = 'Date Error';
            }
        }

        const escapeCsvField = (field) => {
            const stringField = String(field == null ? '' : field);
            // Escape double quotes and wrap in double quotes if comma, newline or double quote exists
            if (stringField.includes(',') || stringField.includes('\n') || stringField.includes('"')) {
                return `"${stringField.replace(/"/g, '""')}"`;
            }
            return stringField;
        };

        return [
            escapeCsvField(deterioration.number),
            escapeCsvField(deterioration.location),
            escapeCsvField(deterioration.name),
            escapeCsvField(deterioration.photoNumber), // Auto-generated number
            escapeCsvField(formattedDate)
        ].join(',');
    });

    const csvContent = [
        csvHeader.join(','),
        ...csvRows
    ].join('\n'); // Use newline character for rows

    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' }); // Add BOM for Excel
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    // Sanitize siteName and buildingId for filename
    const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeBuildingId = buildingId.replace(/[^a-zA-Z0-9_-]/g, '_');
    a.download = `${safeProjectId}_${safeBuildingId}_劣化情報.csv`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();

    // Cleanup
    setTimeout(() => { // Delay revokeObjectURL slightly
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
        console.log("[handleExportCsv] CSV export initiated and cleanup done.");
    }, 100);


  }, (error) => {
    console.error("[handleExportCsv] Error fetching data for export:", error);
    alert("CSVエクスポート用データの取得中にエラーが発生しました: " + error.message);
  });
}


// ======================================================================
// 14. Event Listener Setup - Selection Changes (Site/Building)
// ======================================================================
// ★ 修正: 引数から editPhotoNumberInput を削除
function setupSelectionListeners(siteNameInput, projectDataListElement, buildingSelectElement, activeProjectNameSpanElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */) {
  if (!siteNameInput || !projectDataListElement || !buildingSelectElement || !activeProjectNameSpanElement || !activeBuildingNameSpanElement || !nextIdDisplayElement || !deteriorationTableBodyElement || !editModalElement || !editIdDisplay || !editLocationInput || !editDeteriorationNameInput) {
      console.error("[setupSelectionListeners] Missing one or more required UI elements.");
      return;
  }

  const updateAndDisplayDataList = async () => {
      const projectNames = await populateProjectDataList(projectDataListElement);
      updateDatalistWithOptions(projectNames, projectDataListElement);
  };

  // Populate datalist on focus
  siteNameInput.addEventListener('focus', updateAndDisplayDataList);

  // Handle site name change (when selection is confirmed, e.g., blur or datalist selection)
  siteNameInput.addEventListener('change', async () => {
    const selectedSiteName = siteNameInput.value.trim();
    const projectId = generateProjectId(selectedSiteName);
    console.log(`[Site Name Change] Selected: "${selectedSiteName}", ID: ${projectId}`);

    // Detach old listeners before changing project
    detachAllDeteriorationListeners();

    if (!projectId) {
      console.log("[Site Name Change] No valid project ID. Resetting UI.");
      currentProjectId = null;
      currentBuildingId = null;
      buildingSelectElement.innerHTML = '<option value="">-- 現場を先に選択 --</option>';
      buildingSelectElement.disabled = true;
      activeProjectNameSpanElement.textContent = '未選択';
      activeBuildingNameSpanElement.textContent = '未選択';
      localStorage.removeItem('lastProjectId');
      localStorage.removeItem('lastBuildingId');
      updateNextIdDisplay(null, null, nextIdDisplayElement);
      // ★ 修正: renderDeteriorationTable 呼び出し修正
      renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */);
      return;
    }

    // Check if project exists in Firebase
    const projectInfoRef = getProjectInfoRef(projectId);
    try {
        const snapshot = await projectInfoRef.once('value');
        // Ensure the fetched project info actually corresponds to the selected name
        if (snapshot.exists() && snapshot.val()?.siteName === selectedSiteName) {
          console.log(`[Site Name Change] Project "${selectedSiteName}" exists. Loading details.`);
          currentProjectId = projectId;
          activeProjectNameSpanElement.textContent = selectedSiteName;
          localStorage.setItem('lastProjectId', currentProjectId);

          addProjectToRecentList(selectedSiteName); // Add to recent list
          await updateAndDisplayDataList(); // Refresh datalist with recent item first

          // ★ 修正: updateBuildingSelectorForProject 呼び出し修正
          await updateBuildingSelectorForProject(currentProjectId, buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */);
        } else {
          console.log(`[Site Name Change] Project "${selectedSiteName}" not found or name mismatch. Resetting.`);
          currentProjectId = null;
          currentBuildingId = null;
          buildingSelectElement.innerHTML = '<option value="">-- 現場を先に選択 --</option>';
          buildingSelectElement.disabled = true;
          activeProjectNameSpanElement.textContent = '未選択'; // Indicate no project selected
          activeBuildingNameSpanElement.textContent = '未選択';
          localStorage.removeItem('lastProjectId'); // Clear invalid stored ID
          localStorage.removeItem('lastBuildingId');
          updateNextIdDisplay(null, null, nextIdDisplayElement);
          // ★ 修正: renderDeteriorationTable 呼び出し修正
          renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */);
        }
    } catch (error) {
        console.error("[Site Name Change] Error checking project existence:", error);
        alert("現場情報の確認中にエラーが発生しました。");
        // Reset UI on error
          currentProjectId = null;
          currentBuildingId = null;
          buildingSelectElement.innerHTML = '<option value="">-- 現場を先に選択 --</option>';
          buildingSelectElement.disabled = true;
          activeProjectNameSpanElement.textContent = 'エラー';
          activeBuildingNameSpanElement.textContent = '未選択';
          updateNextIdDisplay(null, null, nextIdDisplayElement);
          renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */);
    }
  });

  // --- Building Select Listener ---
  // ★ 修正: handleBuildingSelectChange の呼び出しも修正
  buildingSelectElement.addEventListener('change', () => handleBuildingSelectChange(buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */));
}

// ★ 修正: handleBuildingSelectChange 関数 (引数と内部呼び出しを修正)
async function handleBuildingSelectChange(buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */) {
  if (!buildingSelectElement || !activeBuildingNameSpanElement || !nextIdDisplayElement || !deteriorationTableBodyElement || !editModalElement || !editIdDisplay || !editLocationInput || !editDeteriorationNameInput) {
      console.error("[handleBuildingSelectChange] Missing required UI elements.");
      return;
  }
  const selectedBuildingId = buildingSelectElement.value;
  console.log(`[Building Select Change] Selected Building ID: ${selectedBuildingId}`);

  // Detach old listeners before changing building
  detachAllDeteriorationListeners();

  if (!currentProjectId || !selectedBuildingId) {
    console.log("[Building Select Change] No current project or no building selected.");
    activeBuildingNameSpanElement.textContent = selectedBuildingId ? (buildingSelectElement.options[buildingSelectElement.selectedIndex]?.text || '不明') : '未選択';
    // ★ 修正: renderDeteriorationTable 呼び出し修正
    renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */);
    updateNextIdDisplay(currentProjectId, null, nextIdDisplayElement); // Update next ID for project, but no building
    currentBuildingId = selectedBuildingId || null; // Update state even if empty
    if (currentBuildingId) localStorage.setItem('lastBuildingId', currentBuildingId);
    else localStorage.removeItem('lastBuildingId');
    return;
  }

  currentBuildingId = selectedBuildingId;
  lastUsedBuilding = currentBuildingId; // Update last used building
  localStorage.setItem('lastBuildingId', currentBuildingId);

  activeBuildingNameSpanElement.textContent = buildingSelectElement.options[buildingSelectElement.selectedIndex]?.text || '不明';

  // ★ 修正: fetchAndRenderDeteriorations 呼び出し修正
  await fetchAndRenderDeteriorations(currentProjectId, currentBuildingId, deteriorationTableBodyElement, nextIdDisplayElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */);
}


// ======================================================================
// 15. Data Loading - Deterioration List
// ======================================================================
// ★ 修正: 引数から editPhotoNumberInput を削除
function setupDeteriorationListener(projectId, buildingId, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */) {
  if (!projectId || !buildingId || !deteriorationTableBodyElement || !editModalElement || !editIdDisplay || !editLocationInput || !editDeteriorationNameInput) {
      console.error("[setupDeteriorationListener] Missing required arguments or UI elements.");
      return;
  }
  const listenerKey = `${projectId}_${buildingId}`;
  // console.log(`[setupDeteriorationListener] Setting up listener for ${listenerKey}`);
  
  // Ensure no duplicate listener
  if (deteriorationListeners[listenerKey]) {
    console.warn(`[setupDeteriorationListener] Detaching existing listener for ${listenerKey}`);
    try {
        deteriorationListeners[listenerKey].ref.off('value', deteriorationListeners[listenerKey].callback);
    } catch (detachError) {
        console.warn(`[setupDeteriorationListener] Error detaching listener:`, detachError);
    }
    delete deteriorationListeners[listenerKey];
  }

  const deteriorationRef = getDeteriorationsRef(projectId, buildingId);

  const listenerCallback = (snapshot) => {
    // console.log(`[Listener Callback] Data received for ${listenerKey}`);
    try {
        const data = snapshot.val() || {};
        deteriorationData[buildingId] = data; // Update local cache if needed elsewhere
        const records = Object.entries(data).map(([id, deterioration]) => ({
          id,
          ...deterioration
        // Sort by descending number (newest first)
        })).sort((a, b) => (b.number || 0) - (a.number || 0));
        // console.log(`[Listener Callback] Rendering ${records.length} records for ${listenerKey}`);
        // ★ 修正: renderDeteriorationTable 呼び出し修正
        renderDeteriorationTable(records, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */);
        // console.log(`[Listener Callback] Finished rendering for ${listenerKey}`);
    } catch (callbackError) {
        console.error(`[Listener Callback] <<<< ERROR >>>> Processing/Rendering for ${listenerKey}:`, callbackError);
        // ★ 修正: renderDeteriorationTable 呼び出し修正
        renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */);
        if (deteriorationTableBodyElement) {
        deteriorationTableBodyElement.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-red-500">劣化リストの表示中にエラーが発生しました。</td></tr>';
        }
    }
  };

  // console.log(`[setupDeteriorationListener] Attaching new listener for ${listenerKey}`);
  deteriorationRef.orderByChild('createdAt').on('value', listenerCallback, (error) => { // Order by creation time for listener? Or number? Let's stick with default/number for render sort.
    console.error(`[setupDeteriorationListener] <<<< LISTENER ERROR >>>> ${listenerKey}:`, error);
    // ★ 修正: renderDeteriorationTable 呼び出し修正
    renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */);
    if (deteriorationTableBodyElement) {
        deteriorationTableBodyElement.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-red-500\">データのリアルタイム受信に失敗しました。</td></tr>';
    }
    // Clean up failed listener?
     delete deteriorationListeners[listenerKey];
  });

  // Store the listener details for later detachment
  deteriorationListeners[listenerKey] = { ref: deteriorationRef, callback: listenerCallback };
  // console.log(`[setupDeteriorationListener] Listener attached successfully for ${listenerKey}`);
}

// ★ 修正: 引数から editPhotoNumberInput を削除
async function fetchAndRenderDeteriorations(projectId, buildingId, deteriorationTableBodyElement, nextIdDisplayElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */) {
  console.log(`--- fetchAndRenderDeteriorations START for ${projectId}/${buildingId} ---`);
   if (!projectId || !buildingId || !deteriorationTableBodyElement || !nextIdDisplayElement || !editModalElement || !editIdDisplay || !editLocationInput || !editDeteriorationNameInput) {
      console.error("[fetchAndRenderDeteriorations] Missing required arguments or UI elements. Cannot proceed.");
      // Attempt to render empty table if element exists
      if(deteriorationTableBodyElement && editModalElement && editIdDisplay && editLocationInput && editDeteriorationNameInput) {
          renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */);
      }
      if(nextIdDisplayElement) updateNextIdDisplay(projectId, buildingId, nextIdDisplayElement); // Try to update ID display
      console.log(`--- fetchAndRenderDeteriorations END (Missing Args/Elements) ---`);
    return;
  }

  console.log(`[fetchAndRenderDeteriorations] Setting up listener and updating next ID for ${projectId}/${buildingId}`);
  try {
      // Detach any previous listeners for this combination first
      detachAllDeteriorationListeners(); // Detach ALL listeners when changing building/project context

      // Setup the new listener
      // ★ 修正: setupDeteriorationListener 呼び出し修正
      setupDeteriorationListener(projectId, buildingId, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */);
      // console.log(`[fetchAndRenderDeteriorations] Listener setup initiated.`);

      // Update the display for the next deterioration number
      await updateNextIdDisplay(projectId, buildingId, nextIdDisplayElement);
      // console.log(`[fetchAndRenderDeteriorations] Next ID display updated.`);
  } catch (error) {
      console.error(`[fetchAndRenderDeteriorations] <<<< ERROR >>>> During setup for ${projectId}/${buildingId}:`, error);
      // ★ 修正: renderDeteriorationTable 呼び出し修正
      renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */);
      if (deteriorationTableBodyElement) {
      deteriorationTableBodyElement.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-red-500">劣化情報の準備中にエラーが発生しました。</td></tr>';
  }
  }
  console.log(`--- fetchAndRenderDeteriorations END for ${projectId}/${buildingId} ---`);
}


// ======================================================================
// 16. Event Handler - Add Project/Building
// ======================================================================
async function ensureProjectExists(projectId, siteName, projectDataListElement) {
  if (!projectId || !siteName) return false;
  // console.log(`[ensureProjectExists] Checking/Creating project info for ${projectId}...`);
  const projectInfoRef = getProjectInfoRef(projectId);
  let projectInfoCreatedOrUpdated = false;
  try {
      const projectInfoSnapshot = await projectInfoRef.once('value');

      if (!projectInfoSnapshot.exists()) {
        console.log(`[ensureProjectExists] Project info for ${projectId} does not exist. Creating...`);
        await projectInfoRef.set({
          siteName: siteName,
          createdAt: firebase.database.ServerValue.TIMESTAMP
        });
        projectInfoCreatedOrUpdated = true;
        console.log("[ensureProjectExists] Project info created successfully.");
        // Refresh datalist asynchronously after creation
        populateProjectDataList(projectDataListElement).then(names => updateDatalistWithOptions(names, projectDataListElement));
        addProjectToRecentList(siteName); // Add to recent list immediately
      } else {
        // Project exists, check if name needs update
        const existingSiteName = projectInfoSnapshot.val()?.siteName;
        if (existingSiteName !== siteName) {
          console.log(`[ensureProjectExists] Updating project ${projectId} siteName from '${existingSiteName}' to '${siteName}'.`);
          await projectInfoRef.update({ siteName: siteName });
          projectInfoCreatedOrUpdated = true;
          // Refresh datalist asynchronously after update
          populateProjectDataList(projectDataListElement).then(names => updateDatalistWithOptions(names, projectDataListElement));
          addProjectToRecentList(siteName); // Update recent list immediately
        } else {
          // console.log(`[ensureProjectExists] Project info for ${projectId} exists and name is current.`);
        }
      }
  } catch (error) {
      console.error(`[ensureProjectExists] Error checking/saving project info for ${projectId}:`, error);
      throw error; // Re-throw error to be caught by caller
  }
  return projectInfoCreatedOrUpdated;
}

function determineBuildingsToAdd(buildingCheckboxContainer) {
  if (!buildingCheckboxContainer) return { buildingsToAdd: [], lastCheckedBuildingId: null };
  // Default buildings (always included unless deselected, which isn't typical here)
  // Let's assume 'site' and 'A棟' are defaults if no checkboxes are present or used.
  // If checkboxes ARE used, rely on them.
  const defaultBuildings = [
      { id: "site", name: "敷地" },
      { id: "buildingA", name: "A棟" }
  ];
  let buildingsToAddMap = new Map();
  defaultBuildings.forEach(b => buildingsToAddMap.set(b.id, b));

  const allCheckboxes = buildingCheckboxContainer.querySelectorAll('input[name="buildingToAdd"]');
  let lastCheckedBuildingId = null; // Track the ID of the last checked box in order

  // If checkboxes exist, use them as the source of truth
  if (allCheckboxes.length > 0) {
      buildingsToAddMap.clear(); // Clear defaults if checkboxes are present
      allCheckboxes.forEach(checkbox => {
          if (checkbox.checked) {
              const buildingId = checkbox.value;
              const label = buildingCheckboxContainer.querySelector(`label[for="${checkbox.id}"]`);
              const buildingName = label ? label.textContent.trim() : buildingId; // Fallback to ID if no label
              buildingsToAddMap.set(buildingId, { id: buildingId, name: buildingName });
              lastCheckedBuildingId = buildingId; // Update last checked ID
          }
      });
  } else {
      // No checkboxes, use defaults
      lastCheckedBuildingId = defaultBuildings.length > 0 ? defaultBuildings[defaultBuildings.length - 1].id : null;
  }


  // Convert map back to array and sort
  const buildingsToAdd = Array.from(buildingsToAddMap.values());
  const allBuildingTypeOrder = ["site", "buildingA", "buildingB", "buildingC", "buildingD", "buildingE", "buildingF", "buildingG", "buildingH", "buildingI"];
  buildingsToAdd.sort((a, b) => allBuildingTypeOrder.indexOf(a.id) - allBuildingTypeOrder.indexOf(b.id));

  // Determine the effective last checked ID based on the sorted list
  if (buildingsToAdd.length > 0) {
      lastCheckedBuildingId = buildingsToAdd[buildingsToAdd.length - 1].id;
  } else {
      lastCheckedBuildingId = null; // No buildings added
  }


  console.log(`[determineBuildingsToAdd] Buildings determined:`, buildingsToAdd.map(b => b.id), `Last checked: ${lastCheckedBuildingId}`);
  return { buildingsToAdd, lastCheckedBuildingId };
}

async function saveBuildingsToFirebase(projectId, buildingsToAdd) {
  if (!projectId || !buildingsToAdd || buildingsToAdd.length === 0) return false;
  // console.log(`[saveBuildingsToFirebase] Saving ${buildingsToAdd.length} buildings for project ${projectId}...`);
  let wasAnyBuildingAddedOrUpdated = false;
  const buildingAddPromises = buildingsToAdd.map(async (building) => {
    const buildingRef = getBuildingsRef(projectId).child(building.id);
    try {
        const buildingSnapshot = await buildingRef.once('value');
        if (!buildingSnapshot.exists()) {
          await buildingRef.set({
            name: building.name,
            createdAt: firebase.database.ServerValue.TIMESTAMP
          });
          // console.log(`[saveBuildingsToFirebase] Building ${building.id} created.`);
          wasAnyBuildingAddedOrUpdated = true; // Mark change
        } else {
          // Building exists, check if name needs update
          const existingBuildingName = buildingSnapshot.val()?.name;
          if (existingBuildingName !== building.name) {
            console.log(`[saveBuildingsToFirebase] Updating building ${building.id} name from '${existingBuildingName}' to '${building.name}'.`);
            await buildingRef.update({ name: building.name });
            wasAnyBuildingAddedOrUpdated = true; // Mark change
          } else {
            // console.log(`[saveBuildingsToFirebase] Building ${building.id} exists and name is current.`);
          }
        }
    } catch (error) {
        console.error(`[saveBuildingsToFirebase] Error saving/updating building ${building.id}:`, error);
        // Decide if one error should stop all? Here we let others continue.
        // Consider collecting errors and reporting them later.
    }
  });

  await Promise.all(buildingAddPromises); // Wait for all save/update attempts
  // console.log(`[saveBuildingsToFirebase] Completed. Any changes made: ${wasAnyBuildingAddedOrUpdated}`);
  return wasAnyBuildingAddedOrUpdated;
}


// ★ 修正: 引数から editPhotoNumberInput を削除
async function handleAddProjectAndBuilding(siteNameInput, buildingCheckboxContainer, projectDataListElement, buildingSelectElement, activeProjectNameSpanElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, /* ★削除 */ infoTabBtn, detailTabBtn, infoTab, detailTab) {
  console.log("--- Add/Update Project & Buildings Start ---");
  if (!siteNameInput || !buildingCheckboxContainer || !projectDataListElement || !buildingSelectElement || !activeProjectNameSpanElement || !activeBuildingNameSpanElement || !nextIdDisplayElement || !deteriorationTableBodyElement || !editModalElement || !editIdDisplay || !editLocationInput || !editDeteriorationNameInput || !infoTabBtn || !detailTabBtn || !infoTab || !detailTab) {
      console.error("[handleAddProjectAndBuilding] Missing one or more required UI elements.");
      alert("内部エラー: UI要素が不足しています。");
      return;
  }
  const siteName = siteNameInput.value.trim();
  const { buildingsToAdd, lastCheckedBuildingId } = determineBuildingsToAdd(buildingCheckboxContainer);

  if (!siteName) {
    alert("現場名を入力してください。");
    siteNameInput.focus();
    return;
  }
  if (buildingsToAdd.length === 0) {
    // This case might not happen if defaults are enforced, but good to check
    alert("追加または更新する建物を指定してください（通常は敷地とA棟がデフォルトです）。");
    return;
  }

  const projectId = generateProjectId(siteName);
  if (!projectId) {
    alert("現場名が無効です。特殊文字は使えません。");
    siteNameInput.focus();
    return;
  }
  console.log(`[handleAddProjectAndBuilding] Project ID: ${projectId}`);

  // Disable button during operation?
  const addButton = document.getElementById('addBuildingBtn');
  if (addButton) addButton.disabled = true;

  try {
    // 1. Ensure project exists (or create/update it)
    const projectInfoCreatedOrUpdated = await ensureProjectExists(projectId, siteName, projectDataListElement);

    // 2. キャッシュをクリアしてデータリストを強制的に更新
    if (projectInfoCreatedOrUpdated) { // プロジェクト情報が新規作成または更新された場合のみキャッシュクリア
        clearProjectListCache();
        console.log("[handleAddProjectAndBuilding] Project info updated. Refreshing datalist.");
        const updatedProjectNames = await populateProjectDataList(projectDataListElement);
        updateDatalistWithOptions(updatedProjectNames, projectDataListElement);
    }

    // 3. Save/Update the selected buildings
    const wasAnyBuildingAddedOrUpdated = await saveBuildingsToFirebase(projectId, buildingsToAdd);

    console.log(`[handleAddProjectAndBuilding] Project changes: ${projectInfoCreatedOrUpdated}, Building changes: ${wasAnyBuildingAddedOrUpdated}`);

    // 4. Update UI - Selector, Active Names, Table
    currentProjectId = projectId; // Update global state
    localStorage.setItem('lastProjectId', currentProjectId);
    activeProjectNameSpanElement.textContent = siteName; // Update display
    addProjectToRecentList(siteName); // 最近使用したリストに追加

    // Update the building selector and load data for the last checked/relevant building
    await updateBuildingSelectorForProject(
        projectId,
        buildingSelectElement,
        activeBuildingNameSpanElement,
        nextIdDisplayElement,
        deteriorationTableBodyElement,
        editModalElement,
        editIdDisplay,
        editLocationInput,
        editDeteriorationNameInput,
        /* ★削除 */
        lastCheckedBuildingId // Pass the ID of the last checked building to select it
    );

    // 5. Reset checkboxes (optional, keep them checked? Adjust based on desired UX)
    // Consider UX: Maybe keep them checked if user might add more buildings for the same project?
    // Or clear non-defaults:
    // buildingCheckboxContainer.querySelectorAll('input[name="buildingToAdd"]:not(:disabled):not(#addBuilding-site):not(#addBuilding-A)')
    //   .forEach(checkbox => checkbox.checked = false);

    // 6. Switch to detail tab
    switchTab('detail', infoTabBtn, detailTabBtn, infoTab, detailTab);

    // 7. Alert user (optional, depends on UX)
    // alert(`${siteName} の情報と建物を追加/更新しました。`);

  } catch (error) {
    console.error("[handleAddProjectAndBuilding] Error:", error);
    alert("現場情報の追加/更新中にエラーが発生しました。");
  } finally {
      // Re-enable button
      if (addButton) addButton.disabled = false;
      console.log("--- Add/Update Project & Buildings End ---");
  }
}

// ======================================================================
// 17. Basic Info Saving (Separate Function)
// ======================================================================
function saveBasicInfo(siteNameInput) {
  if (!siteNameInput) return;
  const siteName = siteNameInput.value.trim();
  const projectId = generateProjectId(siteName);

  if (projectId && currentProjectId === projectId) { // Only save if it matches the currently loaded project
    const infoRef = getProjectInfoRef(projectId);
    infoRef.once('value').then(snapshot => {
      if (snapshot.exists()) {
        const currentDbSiteName = snapshot.val()?.siteName;
        // Only update if the name is different
        if (siteName && siteName !== currentDbSiteName) {
             console.log(`[saveBasicInfo] Updating site name for ${projectId} to "${siteName}" on blur.`);
             infoRef.update({ siteName: siteName })
             .then(() => {
                 console.log(`[saveBasicInfo] Site name updated.`);
                 // Update display and recent list immediately
                 const activeProjectNameSpanElement = document.getElementById('activeProjectName');
                 if (activeProjectNameSpanElement) activeProjectNameSpanElement.textContent = siteName;
                 addProjectToRecentList(siteName);
                 // Refresh datalist if needed
                 const projectDataListElement = document.getElementById('projectDataList');
                 if (projectDataListElement) {
                    populateProjectDataList(projectDataListElement).then(names => updateDatalistWithOptions(names, projectDataListElement));
                 }
             })
             .catch(error => console.error("Error updating site name:", error));
        }
      } else {
          // This case shouldn't normally happen if currentProjectId is set correctly
          console.warn(`[saveBasicInfo] Project info for current project ${projectId} not found in DB during save attempt.`);
      }
    }).catch(error => {
        console.error("Error checking project info before saving:", error);
    });
  } else if (projectId && currentProjectId !== projectId) {
      console.log(`[saveBasicInfo] Site name input changed, but doesn't match current project (${currentProjectId}). No save triggered on blur.`);
  }
}

function setupBasicInfoListeners(siteNameInput) {
    if (!siteNameInput) return;
    // Save on blur (when focus leaves the input)
    siteNameInput.addEventListener('blur', () => saveBasicInfo(siteNameInput));
    // console.log("[setupBasicInfoListeners] Blur listener for siteNameInput attached.");
}

// ======================================================================
// 18. Listener Cleanup
// ======================================================================
function detachAllDeteriorationListeners() {
  // console.log("[detachAllDeteriorationListeners] Detaching all listeners...");
  let count = 0;
  Object.entries(deteriorationListeners).forEach(([key, listener]) => {
    // console.log(`[detachAllDeteriorationListeners] Detaching listener for ${key}`);
    try {
        if (listener && typeof listener.ref?.off === 'function' && typeof listener.callback === 'function') {
            listener.ref.off('value', listener.callback);
            count++;
        } else {
            console.warn(`[detachAllDeteriorationListeners] Invalid listener object for key ${key}`);
        }
    } catch (detachError) {
        console.warn(`[detachAllDeteriorationListeners] Error detaching listener for ${key}:`, detachError);
    }
    delete deteriorationListeners[key]; // Remove from tracking object
  });
  deteriorationListeners = {}; // Reset the listeners object
  if (count > 0) console.log(`[detachAllDeteriorationListeners] Detached ${count} listeners.`);
}


// ======================================================================
// 19. Initialization
// ======================================================================
async function initializeApp() {
  console.log("Initializing app...");

  // DOM Element References (Ensure all IDs match HTML)
  const infoTabBtn = document.getElementById('infoTabBtn');
  const detailTabBtn = document.getElementById('detailTabBtn');
  const infoTab = document.getElementById('infoTab');
  const detailTab = document.getElementById('detailTab');
  const siteNameInput = document.getElementById('siteName');
  const projectDataListElement = document.getElementById('projectDataList');
  const addBuildingBtn = document.getElementById('addBuildingBtn');
  const buildingSelectElement = document.getElementById('buildingSelect');
  const activeProjectNameSpanElement = document.getElementById('activeProjectName');
  const activeBuildingNameSpanElement = document.getElementById('activeBuildingName');
  const deteriorationForm = document.getElementById('deteriorationForm');
  const locationInput = document.getElementById('locationInput');
  const locationPredictionsElement = document.getElementById('locationPredictions');
  const deteriorationNameInput = document.getElementById('deteriorationNameInput');
  const suggestionsElement = document.getElementById('suggestions');
  // const photoNumberInput = document.getElementById('photoNumberInput'); // ★ 削除
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
  // const editPhotoNumberInput = document.getElementById('editPhotoNumberInput'); // ★ 削除
  const cancelEditBtn = document.getElementById('cancelEditBtn');
  const editSubmitBtn = document.getElementById('editSubmitBtn'); // Get edit submit button
  const buildingCheckboxContainer = document.getElementById('buildingCheckboxContainer');

  // Check if all essential elements were found
  const essentialElements = { infoTabBtn, detailTabBtn, infoTab, detailTab, siteNameInput, projectDataListElement, addBuildingBtn, buildingSelectElement, activeProjectNameSpanElement, activeBuildingNameSpanElement, deteriorationForm, locationInput, locationPredictionsElement, deteriorationNameInput, suggestionsElement, nextIdDisplayElement, submitDeteriorationBtn, continuousAddBtn, deteriorationTableBodyElement, exportCsvBtn, currentYearSpan, editModalElement, editForm, editIdDisplay, editLocationInput, editLocationPredictionsElement, editDeteriorationNameInput, editSuggestionsElement, cancelEditBtn, editSubmitBtn, buildingCheckboxContainer };
  for (const [name, el] of Object.entries(essentialElements)) {
      if (!el) {
          console.error(`Initialization Error: Element with ID assumed for '${name}' not found.`);
          // Optionally alert the user or disable functionality
          // alert(`初期化エラー: 必要なUI要素 '${name}' が見つかりません。`);
          // return; // Stop initialization if critical elements are missing
      }
  }


  await loadPredictionData();

  // --- Event Listeners Setup ---
  if (infoTabBtn && detailTabBtn && infoTab && detailTab) {
    infoTabBtn.addEventListener('click', () => switchTab('info', infoTabBtn, detailTabBtn, infoTab, detailTab));
    detailTabBtn.addEventListener('click', () => switchTab('detail', infoTabBtn, detailTabBtn, infoTab, detailTab));
  }

  if (siteNameInput) setupBasicInfoListeners(siteNameInput);

  // Setup listener for the Add/Update Project button
  // ★ 修正: handleAddProjectAndBuilding 呼び出し修正
  if (addBuildingBtn) {
      // Use a named function for potential removal if needed, though unlikely here
      const addBuildingHandler = () => handleAddProjectAndBuilding(
        siteNameInput,
        buildingCheckboxContainer,
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
        /* ★削除 */
        infoTabBtn,
        detailTabBtn,
        infoTab,
        detailTab
      );
      addBuildingBtn.removeEventListener('click', addBuildingHandler); // Prevent duplicates if script runs again
      addBuildingBtn.addEventListener('click', addBuildingHandler);
      // console.log("[Init] addBuildingBtn listener attached.");
  }


  // Setup listeners for site and building selection changes
  // ★ 修正: setupSelectionListeners 呼び出し修正
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
      editDeteriorationNameInput
      /* ★削除 */
  );

  // Setup listeners for the main deterioration form
  // ★ 修正: handleDeteriorationSubmit の呼び出し引数から photoNumberInput を削除
  if (deteriorationForm && locationInput && deteriorationNameInput && nextIdDisplayElement && locationPredictionsElement) {
      deteriorationForm.addEventListener('submit', (event) => handleDeteriorationSubmit(event, locationInput, deteriorationNameInput, /* ★削除 */ nextIdDisplayElement, locationPredictionsElement));
  }
  if (continuousAddBtn && nextIdDisplayElement && locationInput) {
      continuousAddBtn.addEventListener('click', () => handleContinuousAdd(nextIdDisplayElement, locationInput));
  }

  // Input Predictions (Deterioration Form)
  // ★ 修正: deteriorationNameInput の次のフォーカス先を submit ボタンに
  if (locationInput && locationPredictionsElement) setupPredictionListeners(locationInput, locationPredictionsElement, generateLocationPredictions, 'deteriorationNameInput');
  if (deteriorationNameInput && suggestionsElement) setupPredictionListeners(deteriorationNameInput, suggestionsElement, generateDegradationPredictions, 'submitDeteriorationBtn');

  // Edit Modal Handling
  // ★ 修正: handleEditSubmit の呼び出し引数から editPhotoNumberInput を削除
  if (editForm && editIdDisplay && editLocationInput && editDeteriorationNameInput && editModalElement) {
      editForm.addEventListener('submit', (event) => handleEditSubmit(event, editIdDisplay, editLocationInput, editDeteriorationNameInput, /* ★削除 */ editModalElement));
  }
  if (cancelEditBtn && editModalElement) {
      cancelEditBtn.addEventListener('click', () => {
          editModalElement.classList.add('hidden');
          currentEditRecordId = null; // Clear edit state on cancel
      });
  }
  // ★ 修正: editDeteriorationNameInput の次のフォーカス先を editSubmit ボタンに
  if (editLocationInput && editLocationPredictionsElement) setupPredictionListeners(editLocationInput, editLocationPredictionsElement, generateLocationPredictions, 'editDeteriorationNameInput');
  if (editDeteriorationNameInput && editSuggestionsElement) setupPredictionListeners(editDeteriorationNameInput, editSuggestionsElement, generateDegradationPredictions, 'editSubmitBtn');

  // Other listeners
  if (exportCsvBtn && siteNameInput && buildingSelectElement) {
      exportCsvBtn.addEventListener('click', () => handleExportCsv(siteNameInput, buildingSelectElement));
  }
  if (currentYearSpan) currentYearSpan.textContent = new Date().getFullYear();

  // --- Initial State Loading ---
  const initialProjectNames = await populateProjectDataList(projectDataListElement);
  if (projectDataListElement) updateDatalistWithOptions(initialProjectNames, projectDataListElement);

  const lastProjectId = localStorage.getItem('lastProjectId');
  const lastBuildingId = localStorage.getItem('lastBuildingId'); // Keep this separate
  let projectRestored = false;
  let buildingRestored = false; // Track if building was specifically restored

  if (lastProjectId) {
    console.log(`[Init] Attempting to restore project ID: ${lastProjectId}`);
    const projectInfoRef = getProjectInfoRef(lastProjectId);
    try {
        const infoSnapshot = await projectInfoRef.once('value');
        if (infoSnapshot.exists() && infoSnapshot.val()?.siteName) {
          currentProjectId = lastProjectId;
          const restoredSiteName = infoSnapshot.val().siteName;
          if (siteNameInput) siteNameInput.value = restoredSiteName; // Populate input
          if (activeProjectNameSpanElement) activeProjectNameSpanElement.textContent = restoredSiteName; // Update display
          addProjectToRecentList(restoredSiteName); // Add to recent list
          if (projectDataListElement) updateDatalistWithOptions(initialProjectNames, projectDataListElement); // Refresh datalist
          projectRestored = true;
          console.log(`[Init] Project ${currentProjectId} (${restoredSiteName}) restored.`);

          // Now attempt to load buildings and select the last used one
          lastUsedBuilding = lastBuildingId; // Use the stored lastBuildingId as the hint
          // ★ 修正: updateBuildingSelectorForProject 呼び出し修正
          await updateBuildingSelectorForProject(
              currentProjectId,
              buildingSelectElement,
              activeBuildingNameSpanElement,
              nextIdDisplayElement,
              deteriorationTableBodyElement,
              editModalElement,
              editIdDisplay,
              editLocationInput,
              editDeteriorationNameInput,
              /* ★削除 */
              lastBuildingId // Explicitly pass lastBuildingId as the one to try selecting
          );
          // Check if the currently selected building matches the last stored one
          if (currentBuildingId && currentBuildingId === lastBuildingId) {
              buildingRestored = true;
              console.log(`[Init] Building ${currentBuildingId} restored successfully.`);
          } else {
              console.log(`[Init] Last building ID ${lastBuildingId} could not be restored (Current: ${currentBuildingId}).`);
          }

        } else {
          console.warn(`[Init] Last project ID ${lastProjectId} not found or has no name. Clearing stored IDs.`);
          localStorage.removeItem('lastProjectId');
          localStorage.removeItem('lastBuildingId');
        }
    } catch (error) {
        console.error(`[Init] Error restoring project ${lastProjectId}:`, error);
        localStorage.removeItem('lastProjectId');
        localStorage.removeItem('lastBuildingId');
        if (activeProjectNameSpanElement) activeProjectNameSpanElement.textContent = '復元エラー';
    }
  }

  if (!projectRestored) {
    console.log("[Init] No project restored. Setting default UI state.");
    if (siteNameInput) siteNameInput.value = '';
    if (activeProjectNameSpanElement) activeProjectNameSpanElement.textContent = '未選択';
    if (activeBuildingNameSpanElement) activeBuildingNameSpanElement.textContent = '未選択';
    if (buildingSelectElement) {
        buildingSelectElement.innerHTML = '<option value="">-- 現場を先に選択 --</option>';
        buildingSelectElement.disabled = true;
    }
    if (nextIdDisplayElement) updateNextIdDisplay(null, null, nextIdDisplayElement);
    // ★ 修正: renderDeteriorationTable 呼び出し修正
    if (deteriorationTableBodyElement && editModalElement && editIdDisplay && editLocationInput && editDeteriorationNameInput) {
        renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput /* ★削除 */);
    }
  }

  // Restore last active tab (only if project and building were restored)
  const lastActiveTabId = localStorage.getItem('lastActiveTabId');
  let initialTab = 'info';
  if (lastActiveTabId === 'detail' && projectRestored && buildingRestored) {
    initialTab = 'detail';
    // console.log("[Init] Restoring to detail tab.");
  } else {
    // console.log(`[Init] Setting initial tab to info (LastTab='${lastActiveTabId}', ProjectRestored=${projectRestored}, BuildingRestored=${buildingRestored})`);
  }
  if (infoTabBtn && detailTabBtn && infoTab && detailTab) {
    switchTab(initialTab, infoTabBtn, detailTabBtn, infoTab, detailTab);
  }

  // ★ 削除: 写真番号入力欄の半角数字強制リスナー設定は不要
  // enforceHalfWidthDigits(...)

  console.log("App initialized.");
}

// Run initialization when the DOM is ready
document.addEventListener('DOMContentLoaded', initializeApp);
