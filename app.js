import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY, CAPACITY as DEFAULT_CAPACITY } from "./config.js";

// ---------- 달력 설정 (2026년 10월) ----------
const DAYS_IN_MONTH = 31, FIRST_DAY_OF_WEEK = 4; // 목요일 시작
const SLOTS = ["morning", "afternoon", "evening"];
const SLOT_LABEL = { morning: "오전", afternoon: "오후", evening: "저녁" };
const DOW = ["일","월","화","수","목","금","토"];

// ---------- 요일/시간대 제한 ----------
function dowOf(day) {
  return (FIRST_DAY_OF_WEEK + day - 1) % 7; // 0:일 ... 6:토
}
function isWeekend(day) {
  const d = dowOf(day);
  return d === 0 || d === 6;
}
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
let roomCapacity = DEFAULT_CAPACITY || 4; // 동적 정원 (기본값)
let participants = [];
let currentSelection = {};   // { [day]: Set(slots) }
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
  const { data, error } = await supabase
    .from("rooms")
    .select("participants, capacity")
    .eq("id", ROOM_ID)
    .maybeSingle();

  if (error) { console.error(error); setSync("오류", "bg-red-500"); return; }

  if (data) {
    participants = Array.isArray(data.participants) ? data.participants : [];
    if (data.capacity && Number.isInteger(data.capacity)) {
      roomCapacity = data.capacity;
    }
  } else {
    participants = [];
  }

  setSync("동기화됨", "bg-green-500/70");
  onDataUpdated();
}

async function upsertRoom() {
  const { error } = await supabase
    .from("rooms")
    .upsert({ 
      id: ROOM_ID, 
      participants, 
      capacity: roomCapacity,
      updated_at: new Date().toISOString() 
    });
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
        if (payload.new) {
          if (Array.isArray(payload.new.participants)) {
            participants = payload.new.participants;
          }
          if (payload.new.capacity && Number.isInteger(payload.new.capacity)) {
            roomCapacity = payload.new.capacity;
          }
          onDataUpdated();
        }
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") setSync("실시간 연결됨", "bg-green-500/70");
    });
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
// =========================================================
function attachDayGestures(cell, day) {
  let pressTimer = null;
  let longPressed = false;
  let lastTapTime = 0;
  let startX = 0, startY = 0;
  const LONG_PRESS_MS = 500;
  const DOUBLE_TAP_MS = 300;
  const DRAG_THRESHOLD = 12;

  const beginPress = (x, y) => {
    longPressed = false;
    pointerDown = true;
    startX = x; startY = y;
    dragActive = false;
    dragStartDay = day;

    const cur = currentSelection[day];
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

  const endPress = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    pointerDown = false;
  };

  cell.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    beginPress(t.clientX, t.clientY);
  }, { passive: true });

  cell.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (dragActive) e.preventDefault();
    movePress(t.clientX, t.clientY);
  }, { passive: false });

  cell.addEventListener("touchend", endPress);
  cell.addEventListener("touchcancel", endPress);

  cell.addEventListener("mousedown", (e) => beginPress(e.clientX, e.clientY));
  cell.addEventListener("mousemove", (e) => movePress(e.clientX, e.clientY));
  cell.addEventListener("mouseup", endPress);

  cell.addEventListener("click", () => {
    if (dragActive) { dragActive = false; return; }
    if (longPressed) { longPressed = false; return; }
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

function dayFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const cell = el.closest ? el.closest("[data-date]") : null;
  if (cell && gridInput.contains(cell)) return Number(cell.dataset.date);
  return null;
}

function applyDragTo(day) {
  if (dragMode === "add") currentSelection[day] = new Set(allowedSlots(day));
  else delete currentSelection[day];
  refreshDayCell(day);
}

function applyDragRange(currentDay) {
  const from = Math.min(dragStartDay, currentDay);
  const to = Math.max(dragStartDay, currentDay);
  for (let d = from; d <= to; d++) applyDragTo(d);
}

function bindGlobalDragEnd() {
  const stop = () => { pointerDown = false; };
  window.addEventListener("mouseup", stop);
  window.addEventListener("touchend", stop);
  window.addEventListener("touchcancel", stop);
}

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
//  관리자 메뉴 (비밀번호: 9893)
// =========================================================
function openAdminAuth() {
  document.getElementById("admin-password-input").value = "";
  document.getElementById("admin-pw-error").classList.add("hidden");
  document.getElementById("admin-auth-overlay").classList.remove("hidden");
}

function closeAdminAuth() {
  document.getElementById("admin-auth-overlay").classList.add("hidden");
}

function verifyAdminPassword() {
  const pw = document.getElementById("admin-password-input").value.trim();
  if (pw === "9893") {
    closeAdminAuth();
    openAdminPanel();
  } else {
    document.getElementById("admin-pw-error").classList.remove("hidden");
  }
}

function openAdminPanel() {
  document.getElementById("admin-capacity-input").value = roomCapacity;
  document.getElementById("admin-panel-overlay").classList.remove("hidden");
}

function closeAdminPanel() {
  document.getElementById("admin-panel-overlay").classList.add("hidden");
}

async function saveAdminCapacity() {
  const newCap = parseInt(document.getElementById("admin-capacity-input").value, 10);
  if (isNaN(newCap) || newCap < 1 || newCap > 100) {
    alert("1명 이상 100명 이하의 올바른 인원수를 입력해 주세요.");
    return;
  }

  roomCapacity = newCap;
  const ok = await upsertRoom();
  if (ok) {
    alert(`정원이 ${roomCapacity}명으로 고정 및 업데이트되었습니다.`);
    closeAdminPanel();
    onDataUpdated();
  }
}

// =========================================================
//  저장
// =========================================================
async function saveSchedule() {
  const name = userNameInput.value.trim();
  if (!name) { showError("이름을 입력해주세요."); userNameInput.focus(); return; }
  if (Object.keys(currentSelection).length === 0) { showError("가능한 날짜와 시간을 선택해주세요."); return; }

  await fetchParticipants();

  const idx = participants.findIndex(p => p.name === name);
  const isNew = idx === -1;
  if (isNew && participants.length >= roomCapacity) {
    showError(`정원(${roomCapacity}명)이 모두 찼습니다. 기존 참가자 이름으로만 수정할 수 있습니다.`);
    return;
  }

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

function showError(msg) { 
  if (errorMsg) {
    errorMsg.innerText = msg; 
    errorMsg.classList.remove("hidden"); 
  }
}

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
    if (fab) fab.classList.remove("hidden");
    tabInput.className = "flex-1 py-3 text-sm font-semibold text-indigo-600 border-b-2 border-indigo-600 transition-colors";
    tabResult.className = "flex-1 py-3 text-sm font-semibold text-gray-500 border-b-2 border-transparent transition-colors";
  } else {
    inputView.classList.add("hidden");
    resultView.classList.remove("hidden");
    if (fab) fab.classList.add("hidden");
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

  const dayCounts = {}, slotCounts = {};
  for (let d = 1; d <= DAYS_IN_MONTH; d++) {
    dayCounts[d] = 0;
    SLOTS.forEach(s => slotCounts[`${d}-${s}`] = 0);
  }
  participants.forEach(p => {
    Object.keys(p.dates).forEach(d => {
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
    bestTitle.innerText = total >= roomCapacity
      ? `추천 시간 (${roomCapacity}명 전원 참석 가능)`
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
    noMatch.innerText = total >= roomCapacity
      ? `아직 ${roomCapacity}명 전원이 함께 가능한 시간대가 없습니다. 일부 참가자가 일정을 조정하면 다시 확인해 보세요.`
      : `현재 ${total}/${roomCapacity}명이 등록했습니다. ${roomCapacity}명이 모두 등록되면 전원 가능한 시간을 계산합니다.`;
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

function openHelp() {
  document.getElementById("help-overlay")?.classList.remove("hidden");
}
function closeHelp(e) {
  document.getElementById("help-overlay")?.classList.add("hidden");
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
window.openAdminAuth = openAdminAuth;
window.closeAdminAuth = closeAdminAuth;
window.verifyAdminPassword = verifyAdminPassword;
window.closeAdminPanel = closeAdminPanel;
window.saveAdminCapacity = saveAdminCapacity;

init();
