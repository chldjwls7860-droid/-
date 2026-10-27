import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY, CAPACITY as CONFIG_CAPACITY } from "./config.js";

// ---------- 방(room) 식별 ----------
function getRoomId() {
  const url = new URL(location.href);
  let room = url.searchParams.get("room");
  if (!room) {
    room = Math.random().toString(36).slice(2, 8);
    url.searchParams.set("room", room);
    history.replaceState(null, "", url.toString());
  }
  return room;
}
const ROOM_ID = getRoomId();

// ---------- LocalStorage 백업 키 ----------
const STORAGE_CAPACITY_KEY = `room_capacity_${ROOM_ID}`;
const DEFAULT_CAPACITY = CONFIG_CAPACITY || 8;

function getSavedLocalCapacity() {
  const saved = localStorage.getItem(STORAGE_CAPACITY_KEY);
  if (saved && !isNaN(parseInt(saved, 10))) return parseInt(saved, 10);
  return DEFAULT_CAPACITY;
}
let roomCapacity = getSavedLocalCapacity(); 

// ---------- 다중 월 설정 (26년 10월 ~ 27년 1월) ----------
const MONTHS = [
  { year: 2026, month: 10, days: 31, firstDay: 4 }, // 10월: 31일, 목요일(4) 시작
  { year: 2026, month: 11, days: 30, firstDay: 0 }, // 11월: 30일, 일요일(0) 시작
  { year: 2026, month: 12, days: 31, firstDay: 2 }, // 12월: 31일, 화요일(2) 시작
  { year: 2027, month: 1,  days: 31, firstDay: 5 }  // 1월: 31일, 금요일(5) 시작
];
let currentMonthIndex = 0; // 초기 화면: 10월

const SLOTS = ["morning", "afternoon", "evening"];
const SLOT_LABEL = { morning: "오전", afternoon: "오후", evening: "저녁" };
const DOW = ["일","월","화","수","목","금","토"];

// 현재 보고 있는 달 기준 요일 계산
function dowOf(day, monthConfig = MONTHS[currentMonthIndex]) {
  return (monthConfig.firstDay + day - 1) % 7;
}
function isWeekend(day, monthConfig) {
  const d = dowOf(day, monthConfig);
  return d === 0 || d === 6;
}
function allowedSlots(day, monthConfig = MONTHS[currentMonthIndex]) {
  return isWeekend(day, monthConfig) ? SLOTS : ["evening"];
}
function isSlotAllowed(day, slot) {
  return allowedSlots(day).includes(slot);
}

// 키 생성 (예: "2026-10-15")
function getDateKey(day, monthConfig = MONTHS[currentMonthIndex]) {
  return `${monthConfig.year}-${monthConfig.month}-${day}`;
}

// 과거 호환성 변환 (기존 10월 데이터인 '15' 등을 '2026-10-15'로 변환)
function normalizeDateKey(key) {
  if (!key.includes('-')) return `2026-10-${key}`;
  return key;
}

// ---------- Supabase 클라이언트 ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- 상태 ----------
let participants = [];
let currentSelection = {};   // { "2026-10-1": Set, ... }
let editingName = null;
let sheetDay = null;
let sheetTempSlots = new Set();

// ---------- 드래그 선택 상태 ----------
let dragActive = false;    
let dragStartDay = null;   
let dragMode = "add";      
let pointerDown = false;   

// ---------- DOM ----------
const gridInput = document.getElementById("calendar-grid");
const gridResult = document.getElementById("result-grid");
const userNameInput = document.getElementById("userName");
const errorMsg = document.getElementById("error-msg");
const syncStatus = document.getElementById("sync-status");

// =========================================================
//  Supabase 연동
// =========================================================
async function fetchParticipants() {
  const { data, error } = await supabase.from("rooms").select("*").eq("id", ROOM_ID).maybeSingle();
  if (error) { setSync("오류", "bg-red-500"); return; }
  
  if (data) {
    participants = Array.isArray(data.participants) ? data.participants : [];
    if (data.capacity && Number.isInteger(data.capacity) && data.capacity > 0) {
      roomCapacity = data.capacity;
      localStorage.setItem(STORAGE_CAPACITY_KEY, roomCapacity);
    }
  } else {
    participants = [];
  }
  setSync("동기화됨", "bg-green-500/70");
  onDataUpdated();
}

async function upsertRoom() {
  localStorage.setItem(STORAGE_CAPACITY_KEY, roomCapacity);
  const payload = { id: ROOM_ID, participants, capacity: roomCapacity, updated_at: new Date().toISOString() };
  const { error } = await supabase.from("rooms").upsert(payload);
  if (error && error.message.includes("capacity")) {
    delete payload.capacity;
    await supabase.from("rooms").upsert(payload);
  }
  return true;
}

function subscribeRealtime() {
  supabase
    .channel("room-" + ROOM_ID)
    .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${ROOM_ID}` },
      (payload) => {
        if (payload.new) {
          if (Array.isArray(payload.new.participants)) participants = payload.new.participants;
          if (payload.new.capacity && Number.isInteger(payload.new.capacity)) {
            roomCapacity = payload.new.capacity;
            localStorage.setItem(STORAGE_CAPACITY_KEY, roomCapacity);
          }
          onDataUpdated();
        }
      }
    ).subscribe((status) => { if (status === "SUBSCRIBED") setSync("실시간 연결됨", "bg-green-500/70"); });
}

function setSync(text, colorClass) {
  if (!syncStatus) return;
  syncStatus.innerText = text;
  syncStatus.className = "text-[11px] px-2 py-0.5 rounded-full text-white " + colorClass;
}

function onDataUpdated() {
  updateCapacityBadge();
  const resultVisible = !document.getElementById("view-result")?.classList.contains("hidden");
  if (resultVisible) updateResults();
}

// =========================================================
//  초기화 & 월 변경 관리
// =========================================================
async function init() {
  updateMonthUI();
  bindSlotButtons();
  bindGlobalDragEnd();
  switchTab("input");
  setSync("연결 중…", "bg-indigo-500/60");
  updateCapacityBadge(); 
  await fetchParticipants();
  subscribeRealtime();
}

function changeMonth(delta) {
  const newIdx = currentMonthIndex + delta;
  if (newIdx >= 0 && newIdx < MONTHS.length) {
    currentMonthIndex = newIdx;
    updateMonthUI();
  }
}

function updateMonthUI() {
  const m = MONTHS[currentMonthIndex];
  const title = `${m.year.toString().slice(2)}년 ${m.month}월`;
  document.getElementById("current-month-title-input").innerText = title;
  document.getElementById("current-month-title-res").innerText = title;

  const prevDisabled = currentMonthIndex === 0;
  const nextDisabled = currentMonthIndex === MONTHS.length - 1;

  ['btn-prev-month', 'btn-prev-month-res'].forEach(id => {
    const el = document.getElementById(id);
    if(el) { el.disabled = prevDisabled; el.classList.toggle('opacity-30', prevDisabled); }
  });
  ['btn-next-month', 'btn-next-month-res'].forEach(id => {
    const el = document.getElementById(id);
    if(el) { el.disabled = nextDisabled; el.classList.toggle('opacity-30', nextDisabled); }
  });

  const isResultView = !document.getElementById("view-result").classList.contains("hidden");
  if (isResultView) updateResults();
  else renderInputCalendar();
}

function updateCapacityBadge() {
  const badge = document.getElementById("capacity-badge");
  if (badge) badge.innerText = `${participants.length} / ${roomCapacity}`;

  const label = document.getElementById("submit-label");
  const btn = document.getElementById("submit-btn");

  if (participants.length >= roomCapacity && !editingName) {
    if (label) label.innerText = "정원 마감 (기존 이름으로 수정 가능)";
    if (btn) btn.classList.add("opacity-90");
  } else {
    if (label) label.innerText = editingName ? `"${editingName}" 일정 수정하기` : "내 일정 등록하기";
    if (btn) btn.classList.remove("opacity-90");
  }
}

// =========================================================
//  캘린더 UI & 제스처 (입력)
// =========================================================
function renderInputCalendar() {
  const m = MONTHS[currentMonthIndex];
  gridInput.innerHTML = "";
  for (let i = 0; i < m.firstDay; i++) addEmpty(gridInput);

  for (let day = 1; day <= m.days; day++) {
    const dow = dowOf(day);
    let textColor = "text-gray-800";
    if (dow === 0) textColor = "text-red-500";
    if (dow === 6) textColor = "text-blue-500";

    const cell = document.createElement("div");
    cell.className = "calendar-cell bg-white h-16 flex flex-col items-center justify-center cursor-pointer border-2 border-transparent relative select-none";
    cell.dataset.date = day;

    const dateNum = document.createElement("span");
    dateNum.className = `text-base font-semibold ${textColor} z-10 pointer-events-none`;
    dateNum.innerText = day;
    cell.appendChild(dateNum);

    const dots = document.createElement("div");
    dots.className = "flex gap-0.5 mt-1 h-1.5 pointer-events-none";
    dots.id = `dots-${day}`;
    cell.appendChild(dots);

    attachDayGestures(cell, day);
    gridInput.appendChild(cell);
    refreshDayCell(day);
  }
  fillTail(gridInput, m.firstDay, m.days);
}

function attachDayGestures(cell, day) {
  let pressTimer = null, longPressed = false, lastTapTime = 0, startX = 0, startY = 0;
  const LONG_PRESS_MS = 500, DOUBLE_TAP_MS = 300, DRAG_THRESHOLD = 12;

  const beginPress = (x, y) => {
    longPressed = false; pointerDown = true; startX = x; startY = y;
    dragActive = false; dragStartDay = day;

    const key = getDateKey(day);
    const cur = currentSelection[key];
    const allowed = allowedSlots(day);
    const full = cur && allowed.every(s => cur.has(s)) && cur.size === allowed.length;
    dragMode = full ? "remove" : "add";

    pressTimer = setTimeout(() => {
      if (dragActive) return;
      longPressed = true;
      toggleAllSlots(day);
      if (navigator.vibrate) navigator.vibrate(30);
    }, LONG_PRESS_MS);
  };

  const movePress = (x, y) => {
    if (!pointerDown) return;
    const moved = Math.abs(x - startX) + Math.abs(y - startY);
    if (!dragActive && moved > DRAG_THRESHOLD) {
      dragActive = true;
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      applyDragTo(dragStartDay);
    }
    if (dragActive) {
      const overDay = dayFromPoint(x, y);
      if (overDay != null) applyDragRange(overDay);
    }
  };

  const endPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } pointerDown = false; };

  cell.addEventListener("touchstart", (e) => beginPress(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
  cell.addEventListener("touchmove", (e) => { if (dragActive) e.preventDefault(); movePress(e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
  cell.addEventListener("touchend", endPress);
  cell.addEventListener("touchcancel", endPress);

  cell.addEventListener("mousedown", (e) => beginPress(e.clientX, e.clientY));
  cell.addEventListener("mousemove", (e) => movePress(e.clientX, e.clientY));
  cell.addEventListener("mouseup", endPress);

  cell.addEventListener("click", () => {
    if (dragActive || longPressed) { dragActive = false; longPressed = false; return; }
    const now = Date.now();
    if (now - lastTapTime < DOUBLE_TAP_MS) {
      lastTapTime = 0; toggleAllSlots(day);
    } else {
      lastTapTime = now;
      setTimeout(() => {
        if (lastTapTime !== 0 && Date.now() - lastTapTime >= DOUBLE_TAP_MS - 20) {
          lastTapTime = 0; openTimeSheet(day);
        }
      }, DOUBLE_TAP_MS);
    }
  });
}

function dayFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const cell = el.closest ? el.closest("[data-date]") : null;
  if (cell && gridInput.contains(cell)) return Number(cell.dataset.date);
  return null;
}

function applyDragTo(day) {
  const key = getDateKey(day);
  if (dragMode === "add") currentSelection[key] = new Set(allowedSlots(day));
  else delete currentSelection[key];
  refreshDayCell(day);
}
function applyDragRange(currentDay) {
  for (let d = Math.min(dragStartDay, currentDay); d <= Math.max(dragStartDay, currentDay); d++) applyDragTo(d);
}
function bindGlobalDragEnd() {
  const stop = () => { pointerDown = false; };
  window.addEventListener("mouseup", stop); window.addEventListener("touchend", stop); window.addEventListener("touchcancel", stop);
}
function toggleAllSlots(day) {
  const key = getDateKey(day);
  const allowed = allowedSlots(day);
  const cur = currentSelection[key];
  const full = cur && allowed.every(s => cur.has(s)) && cur.size === allowed.length;
  if (full) delete currentSelection[key];
  else currentSelection[key] = new Set(allowed);
  refreshDayCell(day);
}
function refreshDayCell(day) {
  const cell = gridInput.querySelector(`[data-date="${day}"]`);
  if (!cell) return;
  const dots = document.getElementById(`dots-${day}`);
  const slots = currentSelection[getDateKey(day)];
  dots.innerHTML = "";
  if (slots && slots.size > 0) {
    cell.classList.remove("border-transparent");
    cell.classList.add("border-indigo-500", "rounded-lg", "bg-indigo-50");
    SLOTS.forEach(s => {
      if (slots.has(s)) {
        const dot = document.createElement("div");
        dot.className = "w-1.5 h-1.5 rounded-full bg-indigo-600";
        dots.appendChild(dot);
      }
    });
  } else {
    cell.classList.add("border-transparent");
    cell.classList.remove("border-indigo-500", "rounded-lg", "bg-indigo-50");
  }
}

// =========================================================
//  시간대 선택 바텀시트
// =========================================================
function bindSlotButtons() {
  document.querySelectorAll(".slot-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const s = btn.dataset.slot;
      if (sheetDay != null && !isSlotAllowed(sheetDay, s)) return;
      sheetTempSlots.has(s) ? sheetTempSlots.delete(s) : sheetTempSlots.add(s);
      paintSheetButtons();
    });
  });
}

function paintSheetButtons() {
  document.querySelectorAll(".slot-btn").forEach(btn => {
    const slot = btn.dataset.slot;
    const allowed = sheetDay == null ? true : isSlotAllowed(sheetDay, slot);
    const active = sheetTempSlots.has(slot);

    btn.classList.toggle("border-indigo-600", allowed && active);
    btn.classList.toggle("bg-indigo-50", allowed && active);
    btn.classList.toggle("border-gray-200", allowed && !active);

    if (!allowed) {
      btn.classList.add("opacity-40", "cursor-not-allowed", "border-gray-200");
      btn.classList.remove("border-indigo-600", "bg-indigo-50");
      btn.disabled = true;
    } else {
      btn.classList.remove("opacity-40", "cursor-not-allowed");
      btn.disabled = false;
    }
  });
}

function openTimeSheet(day) {
  sheetDay = day;
  const key = getDateKey(day);
  const m = MONTHS[currentMonthIndex];
  const allowed = allowedSlots(day);
  const base = currentSelection[key] ? [...currentSelection[key]] : [];
  sheetTempSlots = new Set(base.filter(s => allowed.includes(s)));

  const d = DOW[dowOf(day)];
  const lockNote = isWeekend(day, m) ? "" : " · 평일은 저녁만 가능";
  document.getElementById("sheet-date-label").innerText = `${m.month}월 ${day}일 (${d})${lockNote}`;
  paintSheetButtons();
  document.getElementById("sheet-overlay").classList.remove("hidden");
  const sheet = document.getElementById("time-sheet");
  sheet.classList.remove("hidden");
  requestAnimationFrame(() => sheet.classList.remove("sheet-hidden"));
}

function closeTimeSheet() {
  const sheet = document.getElementById("time-sheet");
  sheet.classList.add("sheet-hidden");
  setTimeout(() => { sheet.classList.add("hidden"); document.getElementById("sheet-overlay").classList.add("hidden"); }, 250);
}

function confirmTimeSheet() {
  const key = getDateKey(sheetDay);
  const allowed = allowedSlots(sheetDay);
  const cleaned = [...sheetTempSlots].filter(s => allowed.includes(s));
  if (cleaned.length > 0) currentSelection[key] = new Set(cleaned);
  else delete currentSelection[key];
  refreshDayCell(sheetDay);
  closeTimeSheet();
}

function clearDaySlots() {
  delete currentSelection[getDateKey(sheetDay)];
  refreshDayCell(sheetDay);
  closeTimeSheet();
}

// =========================================================
//  일정 저장
// =========================================================
async function saveSchedule() {
  const name = userNameInput.value.trim();
  if (!name) { showError("이름을 입력해주세요."); userNameInput.focus(); return; }
  if (Object.keys(currentSelection).length === 0) { showError("가능한 날짜와 시간을 선택해주세요."); return; }

  await fetchParticipants();
  const idx = participants.findIndex(p => p.name === name);
  const isNew = idx === -1;
  if (isNew && participants.length >= roomCapacity) {
    showError(`정원(${roomCapacity}명)이 모두 찼습니다. 기존 참가자 이름으로만 수정할 수 있습니다.`); return;
  }

  const datesObj = {};
  Object.keys(currentSelection).forEach(key => {
    // 키 형식 파싱: "2026-10-15"
    const [y, m, d] = key.split('-').map(Number);
    const monthConfig = MONTHS.find(mon => mon.year === y && mon.month === m);
    if (monthConfig) {
      const allowed = allowedSlots(d, monthConfig);
      const cleaned = [...currentSelection[key]].filter(s => allowed.includes(s));
      if (cleaned.length > 0) datesObj[key] = cleaned;
    }
  });

  if (Object.keys(datesObj).length === 0) { showError("가능한 날짜와 시간을 선택해주세요."); return; }

  if (isNew) participants.push({ name, dates: datesObj });
  else participants[idx] = { name, dates: datesObj };

  const ok = await upsertRoom();
  if (!ok) return;

  errorMsg.classList.add("hidden");
  document.getElementById("modal-title").innerText = isNew ? "등록 완료!" : "수정 완료!";
  document.getElementById("modal-desc").innerText = isNew ? "일정이 저장되었습니다. 종합 결과를 확인해 보세요." : "변경한 일정이 반영되었습니다.";
  const modal = document.getElementById("modal-overlay");
  modal.classList.remove("hidden");
  setTimeout(() => document.getElementById("modal-content").classList.remove("scale-95"), 10);
}

function showError(msg) { if (errorMsg) { errorMsg.innerText = msg; errorMsg.classList.remove("hidden"); } }

function closeModalAndShowResult() {
  const modal = document.getElementById("modal-overlay");
  document.getElementById("modal-content").classList.add("scale-95");
  setTimeout(() => modal.classList.add("hidden"), 200);
  userNameInput.value = "";
  currentSelection = {};
  editingName = null;
  document.getElementById("edit-hint").classList.add("hidden");
  updateMonthUI();
  updateCapacityBadge();
  switchTab("result");
}

function loadParticipantForEdit(name) {
  const p = participants.find(x => x.name === name);
  if (!p) return;
  editingName = name;
  userNameInput.value = name;
  currentSelection = {};
  
  Object.keys(p.dates).forEach(rawKey => {
    const key = normalizeDateKey(rawKey); // 구 버전 데이터 호환
    const [y, m, d] = key.split('-').map(Number);
    const monthConfig = MONTHS.find(mon => mon.year === y && mon.month === m);
    if (monthConfig) {
      const allowed = allowedSlots(d, monthConfig);
      const cleaned = (p.dates[rawKey] || []).filter(s => allowed.includes(s));
      if (cleaned.length > 0) currentSelection[key] = new Set(cleaned);
    }
  });

  document.getElementById("edit-hint").classList.remove("hidden");
  updateMonthUI();
  updateCapacityBadge();
  switchTab("input");
  window.scrollTo(0, 0);
}

// =========================================================
//  탭 전환 및 결과 계산 (다중 월 전체 검색)
// =========================================================
function switchTab(tabId) {
  const inputView = document.getElementById("view-input");
  const resultView = document.getElementById("view-result");
  const tabInput = document.getElementById("tab-input");
  const tabResult = document.getElementById("tab-result");
  const fab = document.getElementById("fab-container");

  if (tabId === "input") {
    inputView.classList.remove("hidden"); resultView.classList.add("hidden");
    if (fab) fab.classList.remove("hidden");
    tabInput.className = "flex-1 py-3 text-sm font-semibold text-indigo-600 border-b-2 border-indigo-600 transition-colors";
    tabResult.className = "flex-1 py-3 text-sm font-semibold text-gray-500 border-b-2 border-transparent transition-colors";
  } else {
    inputView.classList.add("hidden"); resultView.classList.remove("hidden");
    if (fab) fab.classList.add("hidden");
    tabResult.className = "flex-1 py-3 text-sm font-semibold text-indigo-600 border-b-2 border-indigo-600 transition-colors";
    tabInput.className = "flex-1 py-3 text-sm font-semibold text-gray-500 border-b-2 border-transparent transition-colors";
    updateResults();
  }
}

function updateResults() {
  const locked = document.getElementById("result-locked");
  const content = document.getElementById("result-content");
  if (participants.length === 0) { locked.classList.remove("hidden"); content.classList.add("hidden"); return; }
  
  locked.classList.add("hidden"); content.classList.remove("hidden");
  document.getElementById("participant-count").innerText = participants.length;
  document.getElementById("participant-total-capacity").innerText = roomCapacity;

  const pList = document.getElementById("participant-list");
  pList.innerHTML = "";
  participants.forEach(p => {
    const badge = document.createElement("button");
    badge.className = "px-3 py-1 bg-white border border-indigo-200 text-indigo-800 rounded-full text-xs font-semibold shadow-sm active:scale-95 transition";
    badge.innerHTML = `${p.name} <span class="text-indigo-400">✎</span>`;
    badge.onclick = () => loadParticipantForEdit(p.name);
    pList.appendChild(badge);
  });

  const total = participants.length;
  const fullSlots = []; // 전체 4개월에서 교집합을 모을 배열

  MONTHS.forEach((monthConfig, mIdx) => {
    const dayCounts = {}, slotCounts = {};
    for (let d = 1; d <= monthConfig.days; d++) {
      const key = `${monthConfig.year}-${monthConfig.month}-${d}`;
      dayCounts[key] = 0;
      SLOTS.forEach(s => slotCounts[`${key}-${s}`] = 0);
    }

    participants.forEach(p => {
      Object.keys(p.dates).forEach(rawKey => {
        const key = normalizeDateKey(rawKey);
        const [y, m, d] = key.split('-').map(Number);
        if (y === monthConfig.year && m === monthConfig.month) {
          const allowed = allowedSlots(d, monthConfig);
          const slots = (p.dates[rawKey] || []).filter(s => allowed.includes(s));
          if (slots.length > 0) dayCounts[key]++;
          slots.forEach(s => slotCounts[`${key}-${s}`]++);
        }
      });
    });

    // 화면(히트맵)은 현재 선택된 월만 렌더링
    if (mIdx === currentMonthIndex) {
      renderHeatmap(dayCounts, total, monthConfig);
    }

    // 전원 참석 가능한 슬롯 찾기
    for (let d = 1; d <= monthConfig.days; d++) {
      const key = `${monthConfig.year}-${monthConfig.month}-${d}`;
      SLOTS.forEach(s => {
        if (total > 0 && slotCounts[`${key}-${s}`] === total) {
          fullSlots.push({ year: monthConfig.year, month: monthConfig.month, day: d, slot: s, dow: dowOf(d, monthConfig) });
        }
      });
    }
  });

  // 추천 시간대 출력
  const bestContainer = document.getElementById("best-dates-container");
  const bestList = document.getElementById("best-dates-list");
  const bestTitle = document.getElementById("best-title");
  const noMatch = document.getElementById("no-full-match");

  if (fullSlots.length > 0) {
    bestContainer.classList.remove("hidden"); noMatch.classList.add("hidden");
    bestTitle.innerText = total >= roomCapacity ? `추천 시간 (${roomCapacity}명 전원 참석)` : `추천 시간 (현재 ${total}명 전원 참석)`;
    bestList.innerHTML = "";
    fullSlots.forEach(({ month, day, slot, dow }) => {
      const li = document.createElement("li");
      li.innerHTML = `<strong>${month}월 ${day}일 (${DOW[dow]}) ${SLOT_LABEL[slot]}</strong> — 전원 가능!`;
      bestList.appendChild(li);
    });
  } else {
    bestContainer.classList.add("hidden"); noMatch.classList.remove("hidden");
    noMatch.innerText = total >= roomCapacity
      ? `아직 ${roomCapacity}명 전원이 함께 가능한 시간대가 없습니다.`
      : `현재 ${total}/${roomCapacity}명이 등록했습니다. 전원이 등록되면 겹치는 시간을 계산합니다.`;
  }
}

function renderHeatmap(dayCounts, total, monthConfig) {
  gridResult.innerHTML = "";
  for (let i = 0; i < monthConfig.firstDay; i++) addEmpty(gridResult);
  for (let day = 1; day <= monthConfig.days; day++) {
    const key = `${monthConfig.year}-${monthConfig.month}-${day}`;
    const count = dayCounts[key] || 0;
    let heatClass = "heat-0";
    if (total > 0 && count > 0) {
      if (count === total) heatClass = "heat-max";
      else {
        const r = count / total;
        if (r <= 0.25) heatClass = "heat-1";
        else if (r <= 0.5) heatClass = "heat-2";
        else if (r <= 0.75) heatClass = "heat-3";
        else heatClass = "heat-4";
      }
    }
    const cell = document.createElement("div");
    cell.className = `h-16 flex flex-col items-center justify-center relative ${heatClass}`;
    const dateNum = document.createElement("span");
    dateNum.className = "text-sm font-bold z-10"; dateNum.innerText = day;
    const countText = document.createElement("span");
    countText.className = "text-[10px] z-10 mt-1 opacity-90";
    countText.innerText = count > 0 ? `${count}명` : "";
    cell.appendChild(dateNum); cell.appendChild(countText);
    gridResult.appendChild(cell);
  }
  fillTail(gridResult, monthConfig.firstDay, monthConfig.days);
}

// ---------- 유틸 ----------
function addEmpty(grid) {
  const e = document.createElement("div"); e.className = "bg-white h-16"; grid.appendChild(e);
}
function fillTail(grid, firstDay, days) {
  const total = firstDay + days;
  const rem = total % 7;
  if (rem !== 0) for (let i = 0; i < 7 - rem; i++) addEmpty(grid);
}

async function shareRoom() {
  const url = location.href;
  try { if (navigator.share) await navigator.share({ title: "일정 조율", url }); else { await navigator.clipboard.writeText(url); alert("방 링크가 복사되었습니다.\n" + url); } } catch (e) {}
}

function openHelp() { document.getElementById("help-overlay")?.classList.remove("hidden"); }
function closeHelp(e) { document.getElementById("help-overlay")?.classList.add("hidden"); }

// 관리자 기능
function openAdminAuth() { document.getElementById("admin-password-input").value = ""; document.getElementById("admin-pw-error").classList.add("hidden"); document.getElementById("admin-auth-overlay").classList.remove("hidden"); }
function closeAdminAuth() { document.getElementById("admin-auth-overlay").classList.add("hidden"); }
function verifyAdminPassword() { if (document.getElementById("admin-password-input").value.trim() === "9893") { closeAdminAuth(); openAdminPanel(); } else document.getElementById("admin-pw-error").classList.remove("hidden"); }
function openAdminPanel() { document.getElementById("admin-capacity-input").value = roomCapacity; document.getElementById("admin-panel-overlay").classList.remove("hidden"); }
function closeAdminPanel() { document.getElementById("admin-panel-overlay").classList.add("hidden"); }
async function saveAdminCapacity() {
  const newCap = parseInt(document.getElementById("admin-capacity-input").value, 10);
  if (isNaN(newCap) || newCap < 1 || newCap > 100) return alert("1~100의 숫자를 입력해주세요.");
  roomCapacity = newCap; localStorage.setItem(STORAGE_CAPACITY_KEY, roomCapacity);
  onDataUpdated(); closeAdminPanel(); await upsertRoom(); alert(`정원이 ${roomCapacity}명으로 변경되었습니다.`);
}

// ---------- HTML 전역 노출 ----------
window.switchTab = switchTab;
window.saveSchedule = saveSchedule;
window.closeModalAndShowResult = closeModalAndShowResult;
window.confirmTimeSheet = confirmTimeSheet;
window.clearDaySlots = clearDaySlots;
window.closeTimeSheet = closeTimeSheet;
window.shareRoom = shareRoom;
window.openHelp = openHelp;
window.closeHelp = closeHelp;
window.changeMonth = changeMonth;
window.openAdminAuth = openAdminAuth;
window.closeAdminAuth = closeAdminAuth;
window.verifyAdminPassword = verifyAdminPassword;
window.closeAdminPanel = closeAdminPanel;
window.saveAdminCapacity = saveAdminCapacity;

init();
