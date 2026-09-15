import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY, CAPACITY } from "./config.js";

// ---------- 달력 설정 (2026년 10월) ----------
const DAYS_IN_MONTH = 31, FIRST_DAY_OF_WEEK = 4; // 목요일 시작
const SLOTS = ["morning", "afternoon", "evening"];
const SLOT_LABEL = { morning: "오전", afternoon: "오후", evening: "저녁" };
const DOW = ["일","월","화","수","목","금","토"];

// ---------- 요일/시간대 제한 ----------
// 평일(월~금)은 저녁만 선택 가능, 주말(토·일)은 전부 가능
function dowOf(day) {
  return (FIRST_DAY_OF_WEEK + day - 1) % 7; // 0:일 ... 6:토
}
function isWeekend(day) {
  const d = dowOf(day);
  return d === 0 || d === 6;
}
// 해당 날짜에 선택 가능한 시간대 배열
function allowedSlots(day) {
  return isWeekend(day) ? SLOTS : ["evening"];
}
function isSlotAllowed(day, slot) {
  return allowedSlots(day).includes(slot);
}

// ---------- 방(room) 식별: ?room=xxxx ----------
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

// ---------- Supabase 클라이언트 ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- 상태 ----------
// participants: [{ name, dates: { [day]: ["morning", ...] } }]
let participants = [];
let currentSelection = {};   // { [day]: Set(slots) }
let editingName = null;
let sheetDay = null;
let sheetTempSlots = new Set();

// ---------- 드래그 선택 상태 ----------
let dragActive = false;    // 실제로 드래그가 발동했는지
let dragStartDay = null;   // 드래그 시작 날짜
let dragMode = "add";      // "add" | "remove"
let pointerDown = false;   // 포인터가 눌린 상태인지

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
  const { data, error } = await supabase
    .from("rooms")
    .select("participants")
    .eq("id", ROOM_ID)
    .maybeSingle();

  if (error) { console.error(error); setSync("오류", "bg-red-500"); return; }

  participants = (data && Array.isArray(data.participants)) ? data.participants : [];
  setSync("동기화됨", "bg-green-500/70");
  onDataUpdated();
}

async function upsertRoom() {
  const { error } = await supabase
    .from("rooms")
    .upsert({ id: ROOM_ID, participants, updated_at: new Date().toISOString() });
  if (error) { console.error(error); showError("저장 실패: " + error.message); return false; }
  return true;
}

function subscribeRealtime() {
  supabase
    .channel("room-" + ROOM_ID)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "rooms", filter: `id=eq.${ROOM_ID}` },
      (payload) => {
        const next = payload.new && payload.new.participants;
        if (Array.isArray(next)) {
          participants = next;
          onDataUpdated();
        }
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") setSync("실시간 연결됨", "bg-green-500/70");
    });
}

function setSync(text, colorClass) {
  syncStatus.innerText = text;
  syncStatus.className = "text-[11px] px-2 py-0.5 rounded-full text-white " + colorClass;
}

// 데이터가 바뀔 때마다 화면 갱신
function onDataUpdated() {
  updateCapacityBadge();
  const resultVisible = !document.getElementById("view-result").classList.contains("hidden");
  if (resultVisible) updateResults();
}

// =========================================================
//  초기화
// =========================================================
async function init() {
  renderInputCalendar();
  bindSlotButtons();
  bindGlobalDragEnd();
  switchTab("input");
  setSync("연결 중…", "bg-indigo-500/60");
  await fetchParticipants();
  subscribeRealtime();
}

function updateCapacityBadge() {
  document.getElementById("capacity-badge").innerText = `${participants.length} / ${CAPACITY}`;
  const label = document.getElementById("submit-label");
  const btn = document.getElementById("submit-btn");
  if (participants.length >= CAPACITY && !editingName) {
    label.innerText = "정원 마감 (기존 이름으로 수정 가능)";
    btn.classList.add("opacity-90");
  } else {
    label.innerText = editingName ? `"${editingName}" 일정 수정하기` : "내 일정 등록하기";
    btn.classList.remove("opacity-90");
  }
}

// =========================================================
//  입력 캘린더
// =========================================================
function renderInputCalendar() {
  gridInput.innerHTML = "";
  for (let i = 0; i < FIRST_DAY_OF_WEEK; i++) addEmpty(gridInput);

  for (let day = 1; day <= DAYS_IN_MONTH; day++) {
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
  fillTail(gridInput);
}

// =========================================================
//  날짜 셀 제스처: 탭 / 더블탭 / 롱프레스 / 드래그
//  - 단일 탭     → 시간대 선택 시트 열기
//  - 더블탭      → 하루 전체(허용된 시간대) 토글
//  - 롱프레스    → 하루 전체(허용된 시간대) 토글
//  - 누르고 드래그 → 인접한 여러 날을 한 번에 (허용된 시간대) 선택/해제
// =========================================================
function attachDayGestures(cell, day) {
  let pressTimer = null;
  let longPressed = false;
  let lastTapTime = 0;
  let startX = 0, startY = 0;
  const LONG_PRESS_MS = 500;
  const DOUBLE_TAP_MS = 300;
  const DRAG_THRESHOLD = 12; // 이 픽셀 이상 움직이면 드래그로 판정

  const beginPress = (x, y) => {
    longPressed = false;
    pointerDown = true;
    startX = x; startY = y;
    dragActive = false;
    dragStartDay = day;

    // 드래그 시작 시점의 상태로 add/remove 모드 결정
    // (허용된 시간대가 모두 채워져 있으면 remove 모드)
    const cur = currentSelection[day];
    const allowed = allowedSlots(day);
    const full = cur && allowed.every(s => cur.has(s)) && cur.size === allowed.length;
    dragMode = full ? "remove" : "add";

    pressTimer = setTimeout(() => {
      if (dragActive) return; // 이미 드래그 중이면 롱프레스 무시
      longPressed = true;
      toggleAllSlots(day);
      if (navigator.vibrate) navigator.vibrate(30);
    }, LONG_PRESS_MS);
  };

  const movePress = (x, y) => {
    if (!pointerDown) return;
    const moved = Math.abs(x - startX) + Math.abs(y - startY);
    if (!dragActive && moved > DRAG_THRESHOLD) {
      // 드래그 시작
      dragActive = true;
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      applyDragTo(dragStartDay); // 시작 칸부터 적용
    }
    if (dragActive) {
      const overDay = dayFromPoint(x, y);
      if (overDay != null) applyDragRange(overDay);
    }
  };

  const endPress = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    pointerDown = false;
  };

  // ----- 터치 -----
  cell.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    beginPress(t.clientX, t.clientY);
  }, { passive: true });

  cell.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (dragActive) e.preventDefault(); // 드래그 중 스크롤 방지
    movePress(t.clientX, t.clientY);
  }, { passive: false });

  cell.addEventListener("touchend", endPress);
  cell.addEventListener("touchcancel", endPress);

  // ----- 마우스 -----
  cell.addEventListener("mousedown", (e) => beginPress(e.clientX, e.clientY));
  cell.addEventListener("mousemove", (e) => movePress(e.clientX, e.clientY));
  cell.addEventListener("mouseup", endPress);

  // ----- 클릭(탭/더블탭) : 드래그·롱프레스가 아니었을 때만 -----
  cell.addEventListener("click", () => {
    if (dragActive) { dragActive = false; return; }   // 드래그였으면 무시
    if (longPressed) { longPressed = false; return; }  // 롱프레스였으면 무시
    const now = Date.now();
    if (now - lastTapTime < DOUBLE_TAP_MS) {
      lastTapTime = 0;
      toggleAllSlots(day);
    } else {
      lastTapTime = now;
      setTimeout(() => {
        if (lastTapTime !== 0 && Date.now() - lastTapTime >= DOUBLE_TAP_MS - 20) {
          lastTapTime = 0;
          openTimeSheet(day);
        }
      }, DOUBLE_TAP_MS);
    }
  });
}

// 좌표 아래에 있는 날짜 셀의 날짜 번호를 반환
function dayFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const cell = el.closest ? el.closest("[data-date]") : null;
  if (cell && gridInput.contains(cell)) return Number(cell.dataset.date);
  return null;
}

// 드래그 모드(add/remove)에 따라 특정 날짜에 적용 (허용된 시간대만)
function applyDragTo(day) {
  if (dragMode === "add") currentSelection[day] = new Set(allowedSlots(day));
  else delete currentSelection[day];
  refreshDayCell(day);
}

// 시작 날짜 ~ 현재 날짜 범위 전체에 적용
function applyDragRange(currentDay) {
  const from = Math.min(dragStartDay, currentDay);
  const to = Math.max(dragStartDay, currentDay);
  for (let d = from; d <= to; d++) applyDragTo(d);
}

// 포인터를 화면 어디서 떼든 드래그 종료 처리
function bindGlobalDragEnd() {
  const stop = () => { pointerDown = false; };
  window.addEventListener("mouseup", stop);
  window.addEventListener("touchend", stop);
  window.addEventListener("touchcancel", stop);
}

// 하루의 (허용된) 모든 시간대를 한 번에 선택/해제
function toggleAllSlots(day) {
  const allowed = allowedSlots(day);
  const cur = currentSelection[day];
  const full = cur && allowed.every(s => cur.has(s)) && cur.size === allowed.length;
  if (full) {
    delete currentSelection[day];
  } else {
    currentSelection[day] = new Set(allowed);
  }
  refreshDayCell(day);
}

function refreshDayCell(day) {
  const cell = gridInput.querySelector(`[data-date="${day}"]`);
  if (!cell) return;
  const dots = document.getElementById(`dots-${day}`);
  const slots = currentSelection[day];
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
//  시간대 바텀시트
// =========================================================
function bindSlotButtons() {
  document.querySelectorAll(".slot-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const s = btn.dataset.slot;
      // 평일 잠금: 허용되지 않은 시간대는 무시
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

    // 활성/비활성 스타일
    btn.classList.toggle("border-indigo-600", allowed && active);
    btn.classList.toggle("bg-indigo-50", allowed && active);
    btn.classList.toggle("border-gray-200", allowed && !active);

    // 잠금(비활성) 스타일
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
  // 허용된 시간대만 남겨서 초기화 (평일에 저장된 오전/오후가 있어도 제거)
  const allowed = allowedSlots(day);
  const base = currentSelection[day] ? [...currentSelection[day]] : [];
  sheetTempSlots = new Set(base.filter(s => allowed.includes(s)));

  const dow = DOW[dowOf(day)];
  const lockNote = isWeekend(day) ? "" : " · 평일은 저녁만 가능";
  document.getElementById("sheet-date-label").innerText = `10월 ${day}일 (${dow})${lockNote}`;
  paintSheetButtons();
  document.getElementById("sheet-overlay").classList.remove("hidden");
  const sheet = document.getElementById("time-sheet");
  sheet.classList.remove("hidden");
  requestAnimationFrame(() => sheet.classList.remove("sheet-hidden"));
}
function closeTimeSheet() {
  const sheet = document.getElementById("time-sheet");
  sheet.classList.add("sheet-hidden");
  setTimeout(() => {
    sheet.classList.add("hidden");
    document.getElementById("sheet-overlay").classList.add("hidden");
  }, 250);
}
function confirmTimeSheet() {
  // 허용된 시간대만 저장 (안전장치)
  const allowed = allowedSlots(sheetDay);
  const cleaned = [...sheetTempSlots].filter(s => allowed.includes(s));
  if (cleaned.length > 0) currentSelection[sheetDay] = new Set(cleaned);
  else delete currentSelection[sheetDay];
  refreshDayCell(sheetDay);
  closeTimeSheet();
}
function clearDaySlots() {
  delete currentSelection[sheetDay];
  refreshDayCell(sheetDay);
  closeTimeSheet();
}

// =========================================================
//  저장
// =========================================================
async function saveSchedule() {
  const name = userNameInput.value.trim();
  if (!name) { showError("이름을 입력해주세요."); userNameInput.focus(); return; }
  if (Object.keys(currentSelection).length === 0) { showError("가능한 날짜와 시간을 선택해주세요."); return; }

  // 최신 상태 기준으로 정원 검사 (동시 편집 대비)
  await fetchParticipants();

  const idx = participants.findIndex(p => p.name === name);
  const isNew = idx === -1;
  if (isNew && participants.length >= CAPACITY) {
    showError(`정원(${CAPACITY}명)이 모두 찼습니다. 기존 참가자 이름으로만 수정할 수 있습니다.`);
    return;
  }

  // 저장 직전에도 평일 오전/오후 제거(안전장치)
  const datesObj = {};
  Object.keys(currentSelection).forEach(d => {
    const allowed = allowedSlots(Number(d));
    const cleaned = [...currentSelection[d]].filter(s => allowed.includes(s));
    if (cleaned.length > 0) datesObj[d] = cleaned;
  });

  if (Object.keys(datesObj).length === 0) { showError("가능한 날짜와 시간을 선택해주세요."); return; }

  if (isNew) participants.push({ name, dates: datesObj });
  else participants[idx] = { name, dates: datesObj };

  const ok = await upsertRoom();
  if (!ok) return;

  errorMsg.classList.add("hidden");
  document.getElementById("modal-title").innerText = isNew ? "등록 완료!" : "수정 완료!";
  document.getElementById("modal-desc").innerText = isNew
    ? "일정이 저장되었습니다. 종합 결과를 확인해 보세요."
    : "변경한 일정이 반영되었습니다.";
  const modal = document.getElementById("modal-overlay");
  modal.classList.remove("hidden");
  setTimeout(() => document.getElementById("modal-content").classList.remove("scale-95"), 10);
}

function showError(msg) { errorMsg.innerText = msg; errorMsg.classList.remove("hidden"); }

function closeModalAndShowResult() {
  const modal = document.getElementById("modal-overlay");
  document.getElementById("modal-content").classList.add("scale-95");
  setTimeout(() => modal.classList.add("hidden"), 200);
  userNameInput.value = "";
  currentSelection = {};
  editingName = null;
  document.getElementById("edit-hint").classList.add("hidden");
  renderInputCalendar();
  updateCapacityBadge();
  switchTab("result");
}

function loadParticipantForEdit(name) {
  const p = participants.find(x => x.name === name);
  if (!p) return;
  editingName = name;
  userNameInput.value = name;
  currentSelection = {};
  Object.keys(p.dates).forEach(d => {
    // 불러올 때도 평일 오전/오후는 제외
    const allowed = allowedSlots(Number(d));
    const cleaned = (p.dates[d] || []).filter(s => allowed.includes(s));
    if (cleaned.length > 0) currentSelection[d] = new Set(cleaned);
  });
  document.getElementById("edit-hint").classList.remove("hidden");
  renderInputCalendar();
  updateCapacityBadge();
  switchTab("input");
  window.scrollTo(0, 0);
}

// =========================================================
//  탭 전환
// =========================================================
function switchTab(tabId) {
  const inputView = document.getElementById("view-input");
  const resultView = document.getElementById("view-result");
  const tabInput = document.getElementById("tab-input");
  const tabResult = document.getElementById("tab-result");
  const fab = document.getElementById("fab-container");

  if (tabId === "input") {
    inputView.classList.remove("hidden");
    resultView.classList.add("hidden");
    fab.classList.remove("hidden");
    tabInput.className = "flex-1 py-3 text-sm font-semibold text-indigo-600 border-b-2 border-indigo-600 transition-colors";
    tabResult.className = "flex-1 py-3 text-sm font-semibold text-gray-500 border-b-2 border-transparent transition-colors";
  } else {
    inputView.classList.add("hidden");
    resultView.classList.remove("hidden");
    fab.classList.add("hidden");
    tabResult.className = "flex-1 py-3 text-sm font-semibold text-indigo-600 border-b-2 border-indigo-600 transition-colors";
    tabInput.className = "flex-1 py-3 text-sm font-semibold text-gray-500 border-b-2 border-transparent transition-colors";
    updateResults();
  }
}

// =========================================================
//  결과 계산
// =========================================================
function updateResults() {
  const locked = document.getElementById("result-locked");
  const content = document.getElementById("result-content");

  if (participants.length === 0) {
    locked.classList.remove("hidden");
    content.classList.add("hidden");
    return;
  }
  locked.classList.add("hidden");
  content.classList.remove("hidden");
  document.getElementById("participant-count").innerText = participants.length;

  const pList = document.getElementById("participant-list");
  pList.innerHTML = "";
  participants.forEach(p => {
    const badge = document.createElement("button");
    badge.className = "px-3 py-1 bg-white border border-indigo-200 text-indigo-800 rounded-full text-xs font-semibold shadow-sm active:scale-95 transition";
    badge.innerHTML = `${p.name} <span class="text-indigo-400">✎</span>`;
    badge.onclick = () => loadParticipantForEdit(p.name);
    pList.appendChild(badge);
  });

  const dayCounts = {}, slotCounts = {};
  for (let d = 1; d <= DAYS_IN_MONTH; d++) {
    dayCounts[d] = 0;
    SLOTS.forEach(s => slotCounts[`${d}-${s}`] = 0);
  }
  participants.forEach(p => {
    Object.keys(p.dates).forEach(d => {
      // 결과 계산에서도 평일 오전/오후는 무시(안전장치)
      const allowed = allowedSlots(Number(d));
      const slots = (p.dates[d] || []).filter(s => allowed.includes(s));
      if (slots.length > 0) dayCounts[d]++;
      slots.forEach(s => slotCounts[`${d}-${s}`]++);
    });
  });

  const total = participants.length;
  renderHeatmap(dayCounts, total);

  const fullSlots = [];
  for (let d = 1; d <= DAYS_IN_MONTH; d++) {
    SLOTS.forEach(s => {
      if (total > 0 && slotCounts[`${d}-${s}`] === total) fullSlots.push({ day: d, slot: s });
    });
  }

  const bestContainer = document.getElementById("best-dates-container");
  const bestList = document.getElementById("best-dates-list");
  const bestTitle = document.getElementById("best-title");
  const noMatch = document.getElementById("no-full-match");

  if (fullSlots.length > 0) {
    bestContainer.classList.remove("hidden");
    noMatch.classList.add("hidden");
    bestTitle.innerText = total >= CAPACITY
      ? `추천 시간 (${CAPACITY}명 전원 참석 가능)`
      : `추천 시간 (현재 ${total}명 전원 참석 가능)`;
    bestList.innerHTML = "";
    fullSlots.forEach(({ day, slot }) => {
      const dow = DOW[dowOf(day)];
      const li = document.createElement("li");
      li.innerHTML = `<strong>10월 ${day}일 (${dow}) ${SLOT_LABEL[slot]}</strong> — 전원 가능!`;
      bestList.appendChild(li);
    });
  } else {
    bestContainer.classList.add("hidden");
    noMatch.classList.remove("hidden");
    noMatch.innerText = total >= CAPACITY
      ? "아직 전원이 함께 가능한 시간대가 없습니다. 일부 참가자가 일정을 조정하면 다시 확인해 보세요."
      : `현재 ${total}/${CAPACITY}명이 등록했습니다. ${CAPACITY}명이 모두 등록되면 전원 가능한 시간을 계산합니다.`;
  }
}

function renderHeatmap(dayCounts, total) {
  gridResult.innerHTML = "";
  for (let i = 0; i < FIRST_DAY_OF_WEEK; i++) addEmpty(gridResult);
  for (let day = 1; day <= DAYS_IN_MONTH; day++) {
    const count = dayCounts[day];
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
    dateNum.className = "text-sm font-bold z-10";
    dateNum.innerText = day;
    const countText = document.createElement("span");
    countText.className = "text-[10px] z-10 mt-1 opacity-90";
    countText.innerText = count > 0 ? `${count}명` : "";
    cell.appendChild(dateNum); cell.appendChild(countText);
    gridResult.appendChild(cell);
  }
  fillTail(gridResult);
}

// ---------- 유틸 ----------
function addEmpty(grid) {
  const e = document.createElement("div");
  e.className = "bg-white h-16";
  grid.appendChild(e);
}
function fillTail(grid) {
  const total = FIRST_DAY_OF_WEEK + DAYS_IN_MONTH;
  const rem = total % 7;
  if (rem !== 0) for (let i = 0; i < 7 - rem; i++) addEmpty(grid);
}

async function shareRoom() {
  const url = location.href;
  try {
    if (navigator.share) await navigator.share({ title: "10월 일정 조율", url });
    else { await navigator.clipboard.writeText(url); alert("방 링크가 복사되었습니다.\n" + url); }
  } catch (e) {}
}

// ---------- 도움말 ----------
function openHelp() {
  document.getElementById("help-overlay").classList.remove("hidden");
}
function closeHelp(e) {
  document.getElementById("help-overlay").classList.add("hidden");
}

// ---------- HTML onclick 에서 호출되므로 전역 노출 ----------
window.switchTab = switchTab;
window.saveSchedule = saveSchedule;
window.closeModalAndShowResult = closeModalAndShowResult;
window.confirmTimeSheet = confirmTimeSheet;
window.clearDaySlots = clearDaySlots;
window.closeTimeSheet = closeTimeSheet;
window.shareRoom = shareRoom;
window.openHelp = openHelp;
window.closeHelp = closeHelp;

init();
