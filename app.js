/* Firebase Web SDK 11.x via browser CDN ES modules; no bundler/build step. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';
import { getFirestore, collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';

// TODO: Firebase Console > Project settings > Your apps > SDK setup and configuration.
// Paste your Firebase web app configuration values into this object before testing.
const firebaseConfig = {
  apiKey: "AIzaSyDE8cj9HcVgEDNoOWj2cwW1pLuOCX0CsKQ",
  authDomain: "ccccc-9f530.firebaseapp.com",
  projectId: "ccccc-9f530",
  storageBucket: "ccccc-9f530.firebasestorage.app",
  messagingSenderId: "1001583028925",
  appId: "1:1001583028925:web:ded2499525469b4e7525d4",
  measurementId: "G-JV4EE3ZZHB"
};

const GEMINI_KEY_STORAGE = 'daymark-gemini-api-key';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const localDateTime = date => {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const parseDate = value => new Date(value);
const dateKey = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const reminderLabel = value => value === 'none' || value == null ? '不提醒' : Number(value) < 60 ? `${value} 分鐘前` : Number(value) === 1440 ? '1 天前' : `${Number(value)/60} 小時前`;
const timeLabel = value => new Intl.DateTimeFormat('zh-TW',{hour:'2-digit',minute:'2-digit',hour12:false}).format(parseDate(value));

let app, auth, db, currentUser = null, unsubscribeTasks = null;
let tasks = [], selectedDate = new Date(), view = 'today', entryMode = 'task';
let editingTaskId = null, toastTimer = null, aiDraft = null, firedReminders = new Set();
selectedDate.setHours(0,0,0,0);

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3000);
}
function formatDay(date) {
  return new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(date);
}
function relativeDay(date) {
  const value = new Date(date); value.setHours(0,0,0,0);
  const base = new Date(); base.setHours(0,0,0,0);
  const days = Math.round((value-base)/86400000);
  if (days===0) return '今天'; if (days===1) return '明天'; if (days===-1) return '昨天';
  return new Intl.DateTimeFormat('zh-TW',{month:'numeric',day:'numeric'}).format(value);
}
function renderHeader() {
  const isToday = dateKey(selectedDate) === dateKey(new Date());
  $('#full-date').textContent = formatDay(selectedDate);
  $('#day-label').textContent = isToday ? '今天' : relativeDay(selectedDate);
  $('#page-title').textContent = currentUser ? (isToday ? `早安，${currentUser.displayName?.split(' ')[0] || '朋友'}` : `${relativeDay(selectedDate)}的安排`) : '登入後開始安排';
  $('#crumb-current').textContent = view === 'tasks' ? '我的待辦' : view === 'notifications' ? '提醒通知' : isToday ? '今天' : relativeDay(selectedDate);
}
function taskCollection() {
  if (!currentUser || !db) throw new Error('請先登入 Google 帳號。');
  // User-owned data path: users/{authenticated uid}/tasks/{task document id}.
  return collection(db, 'users', currentUser.uid, 'tasks');
}
function setAppEnabled(enabled) {
  ['#quick-task','#quick-event','#add-task-link','#entry-submit'].forEach(selector => { $(selector).disabled = !enabled; });
  $('#entry-name').disabled = !enabled;
  $('#entry-due').disabled = !enabled;
  $('#event-start').disabled = !enabled;
  $('#event-end').disabled = !enabled;
  $('#entry-category').disabled = !enabled;
  $('#entry-reminder').disabled = !enabled;
}
function updateIdentity(user) {
  currentUser = user;
  const avatar = $('#user-avatar');
  avatar.replaceChildren();
  if (user) {
    if (user.photoURL) { const image=document.createElement('img'); image.src=user.photoURL; image.alt=''; avatar.append(image); }
    else avatar.textContent=(user.displayName || user.email || 'U').slice(0,1);
    $('#user-name').textContent=user.displayName || 'Google 使用者';
    $('#user-email').textContent=user.email || '已透過 Google 登入';
    $('#auth-button').textContent='登出'; $('#auth-button').setAttribute('aria-label','登出 Google 帳號');
  } else {
    avatar.textContent='?'; $('#user-name').textContent='尚未登入';
    $('#user-email').textContent='資料僅屬於登入帳號';
    $('#auth-button').textContent='登入'; $('#auth-button').setAttribute('aria-label','使用 Google 登入');
  }
  setAppEnabled(Boolean(user));
  renderHeader();
}
function render() {
  renderHeader();
  $$('[data-nav]').forEach(button=>button.classList.toggle('active',button.dataset.nav===view));
  $('#tasks-title').textContent=view==='tasks'?'我的待辦':'待辦任務';
  const dayTasks = tasks.filter(task => {
    const value = task.type === 'event' ? task.startAt : task.dueAt;
    return value && dateKey(parseDate(value)) === dateKey(selectedDate);
  }).sort((a,b) => (a.startAt || a.dueAt).localeCompare(b.startAt || b.dueAt));
  const events = dayTasks.filter(task => task.type === 'event');
  const todos = (view === 'tasks' ? tasks.filter(task => task.type !== 'event') : dayTasks.filter(task => task.type !== 'event'));
  const openTodos = todos.filter(task => !task.completed), doneTodos = todos.filter(task => task.completed);
  $('#agenda-list').innerHTML = events.length ? events.map(event => `<article class="event"><time class="event-time">${timeLabel(event.startAt)} – ${timeLabel(event.endAt)}</time><span class="event-rail"><i class="event-dot"></i></span><div class="event-info"><h3 class="event-name">${escapeHTML(event.title)}</h3><p class="event-location">${escapeHTML(event.note || '尚未新增地點備註')} · 提醒：${reminderLabel(event.reminderMinutes)}</p></div><span class="event-tag">${escapeHTML(event.category || '個人')}<span class="event-tools"><button class="text-button" data-edit="${escapeHTML(event.id)}" aria-label="編輯行程">✎</button><button class="text-button" data-delete="${escapeHTML(event.id)}" aria-label="刪除行程">×</button></span></span></article>`).join('') : '<div class="empty">這天還沒有安排行程。給自己留一點空白也很好。</div>';
  const todoRow = task => {
    const due = task.type === 'event' ? task.startAt : task.dueAt;
    const late = !task.completed && task.type !== 'event' && parseDate(due) < new Date();
    return `<div class="todo-item ${task.completed?'is-done':''}"><button class="check" data-toggle="${escapeHTML(task.id)}" aria-label="${task.completed?'標記未完成':'標記完成'}：${escapeHTML(task.title)}" aria-pressed="${Boolean(task.completed)}">${task.completed?'✓':''}</button><div class="todo-copy"><span class="todo-name">${escapeHTML(task.title)}</span><span class="todo-due ${late?'overdue':''}">${escapeHTML(task.category||'個人')} · ${relativeDay(parseDate(due))} ${timeLabel(due)}${late?' · 已逾期':''} · 提醒 ${reminderLabel(task.reminderMinutes)}</span></div><div class="todo-right"><span class="todo-state">${task.completed?'已完成':late?'已逾期':'待處理'}</span><button class="todo-edit" data-edit="${escapeHTML(task.id)}" aria-label="編輯${task.type==='event'?'行程':'待辦'}">✎</button><button class="todo-edit" data-delete="${escapeHTML(task.id)}" aria-label="刪除項目">×</button></div></div>`;
  };
  $('#todo-list').innerHTML = `${openTodos.length ? openTodos.map(todoRow).join('') : '<div class="empty">沒有待處理事項，享受這段空檔吧。</div>'}${doneTodos.length ? `<details class="done-group"><summary>已完成 · ${doneTodos.length}</summary>${doneTodos.map(todoRow).join('')}</details>` : ''}`;
  $('#event-count').innerHTML=`${events.length} <small>場</small>`;
  $('#todo-count').innerHTML=`${openTodos.length} <small>項待完成</small>`;
  $('#todo-progress').textContent=`${doneTodos.length} / ${todos.length} 項已完成`;
  const nextEvent=events.find(event=>parseDate(event.startAt)>new Date());
  $('#next-event').textContent=nextEvent?`下一場 ${timeLabel(nextEvent.startAt)} · ${nextEvent.title}`:'今天的節奏剛剛好';
  $('#nav-tasks').textContent=tasks.filter(task=>task.type!=='event'&&!task.completed).length || '';
  const reminders=tasks.filter(task=>!task.completed && task.reminderMinutes!=='none' && task.reminderMinutes!=null).sort((a,b)=>{
    const aTime=parseDate(a.type==='event'?a.startAt:a.dueAt).getTime()-Number(a.reminderMinutes)*60000;
    const bTime=parseDate(b.type==='event'?b.startAt:b.dueAt).getTime()-Number(b.reminderMinutes)*60000; return aTime-bTime;
  });
  $('#reminder-count').innerHTML=`${reminders.length} <small>則</small>`;
  $('#nav-notifications').textContent=reminders.length || '';
  const upcoming=reminders.filter(task=>parseDate(task.type==='event'?task.startAt:task.dueAt).getTime()-Number(task.reminderMinutes)*60000 >= Date.now()).slice(0,3);
  $('#notice-list').innerHTML=upcoming.length?upcoming.map(task=>`<div class="notice"><span class="notice-icon">♧</span><div><div class="notice-title">${escapeHTML(task.title)}</div><div class="notice-meta">${task.type==='event'?'行程':'待辦'} · ${relativeDay(parseDate(task.type==='event'?task.startAt:task.dueAt))} ${timeLabel(task.type==='event'?task.startAt:task.dueAt)} · ${reminderLabel(task.reminderMinutes)}</div></div></div>`).join(''):'<div class="empty">目前沒有待提醒事項</div>';
  checkReminders();
}
function listenForTasks(user) {
  if (unsubscribeTasks) { unsubscribeTasks(); unsubscribeTasks=null; }
  tasks=[];
  if (!user) {
    $('#agenda-list').innerHTML='<div class="empty">登入後顯示你的行程</div>';
    $('#todo-list').innerHTML='<div class="empty">登入後顯示你的待辦</div>';
    $('#notice-list').innerHTML='<div class="empty">登入後顯示提醒</div>';
    $('#event-count').innerHTML='0 <small>場</small>'; $('#todo-count').innerHTML='0 <small>項</small>'; $('#reminder-count').innerHTML='0 <small>則</small>';
    return;
  }
  $('#agenda-list').innerHTML='<div class="empty">正在從 Firestore 載入…</div>';
  unsubscribeTasks = onSnapshot(taskCollection(), snapshot => {
    tasks = snapshot.docs.map(item => ({ id:item.id, ...item.data() })); render();
  }, error => {
    console.error('Firestore listener failed:', error);
    toast(`無法載入 Firestore：${error.message}`);
  });
}
function setMode(mode) {
  entryMode=mode;
  $$('[data-mode]').forEach(button=>button.classList.toggle('selected',button.dataset.mode===mode));
  const isTask=mode==='task';
  $('#due-field').hidden=!isTask; $('#event-time-fields').hidden=isTask;
  $('#entry-due').required=isTask; $('#event-start').required=!isTask; $('#event-end').required=!isTask;
  $('#entry-submit').textContent=isTask?'＋ 建立待辦':'＋ 安排行程';
  $('#entry-subtitle').textContent=isTask?'加上期限與提醒，完成後收進完成區':'行程會同步儲存到你的 Firestore 帳號';
}
function initializeDates() {
  const first=new Date(Date.now()+3600000), second=new Date(Date.now()+7200000);
  $('#entry-due').value=localDateTime(first); $('#event-start').value=localDateTime(first); $('#event-end').value=localDateTime(second);
}
async function createTask(data) {
  await addDoc(taskCollection(), { ...data, createdAt:serverTimestamp(), updatedAt:serverTimestamp() });
}
async function saveEntry(event) {
  event.preventDefault();
  if (!currentUser) return toast('請先使用 Google 登入。');
  const title=$('#entry-name').value.trim(); if(!title)return;
  const reminder=$('#entry-reminder').value==='none'?'none':Number($('#entry-reminder').value);
  try {
    if(entryMode==='task') {
      const dueAt=$('#entry-due').value; if(!dueAt)return;
      await createTask({type:'task',title,dueAt,category:$('#entry-category').value,reminderMinutes:reminder,completed:false});
      toast('待辦已儲存到 Firestore');
    } else {
      const startAt=$('#event-start').value,endAt=$('#event-end').value;
      if(!startAt||!endAt||parseDate(endAt)<=parseDate(startAt))return toast('請確認結束時間晚於開始時間。');
      await createTask({type:'event',title,startAt,endAt,category:$('#entry-category').value,note:'',reminderMinutes:reminder,completed:false});
      toast('行程已儲存到 Firestore');
    }
    event.target.reset();setMode(entryMode);initializeDates();
  } catch(error) { console.error(error); toast(`儲存失敗：${error.message}`); }
}
function openEditor(id) {
  const task=tasks.find(item=>item.id===id); if(!task)return;
  editingTaskId=id;
  if(task.type==='event') {
    $('#event-dialog-title').textContent='編輯行程'; $('#modal-event-name').value=task.title;
    $('#modal-event-start').value=task.startAt; $('#modal-event-end').value=task.endAt;
    $('#modal-event-category').value=task.category||'個人'; $('#modal-event-note').value=task.note||'';
    $('#modal-event-reminder').value=String(task.reminderMinutes??'none'); $('#event-dialog').showModal();
  } else {
    $('#task-dialog-title').textContent='編輯待辦'; $('#modal-task-name').value=task.title;
    $('#modal-task-due').value=task.dueAt; $('#modal-task-category').value=task.category||'個人';
    $('#modal-task-reminder').value=String(task.reminderMinutes??'none'); $('#task-dialog').showModal();
  }
}
async function updateTask(id, patch) {
  if(!currentUser)return;
  await updateDoc(doc(db,'users',currentUser.uid,'tasks',id),{...patch,updatedAt:serverTimestamp()});
}
$('#entry-form').addEventListener('submit',saveEntry);
$('#event-dialog-form').addEventListener('submit',async event=>{
  event.preventDefault(); if(!editingTaskId)return;
  const startAt=$('#modal-event-start').value,endAt=$('#modal-event-end').value;
  if(parseDate(endAt)<=parseDate(startAt))return toast('結束時間需要晚於開始時間。');
  try { await updateTask(editingTaskId,{title:$('#modal-event-name').value.trim(),startAt,endAt,category:$('#modal-event-category').value,note:$('#modal-event-note').value.trim(),reminderMinutes:$('#modal-event-reminder').value==='none'?'none':Number($('#modal-event-reminder').value)});$('#event-dialog').close();editingTaskId=null;toast('行程已更新'); }
  catch(error){toast(`更新失敗：${error.message}`)}
});
$('#task-dialog-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!editingTaskId)return;
  try { await updateTask(editingTaskId,{title:$('#modal-task-name').value.trim(),dueAt:$('#modal-task-due').value,category:$('#modal-task-category').value,reminderMinutes:$('#modal-task-reminder').value==='none'?'none':Number($('#modal-task-reminder').value)});$('#task-dialog').close();editingTaskId=null;toast('待辦已更新'); }
  catch(error){toast(`更新失敗：${error.message}`)}
});
$('#agenda-list').addEventListener('click',event=>handleItemAction(event));
$('#todo-list').addEventListener('click',event=>handleItemAction(event));
async function handleItemAction(event) {
  const toggle=event.target.closest('[data-toggle]'), edit=event.target.closest('[data-edit]'), remove=event.target.closest('[data-delete]');
  try {
    if(toggle){const task=tasks.find(item=>item.id===toggle.dataset.toggle);if(task){await updateTask(task.id,{completed:!task.completed});toast(task.completed?'已移回待辦':'已完成並移至完成區')}}
    if(edit)openEditor(edit.dataset.edit);
    if(remove&&currentUser){await deleteDoc(doc(db,'users',currentUser.uid,'tasks',remove.dataset.delete));toast('已刪除項目');}
  } catch(error){toast(`操作失敗：${error.message}`)}
}
$$('[data-mode]').forEach(button=>button.addEventListener('click',()=>setMode(button.dataset.mode)));
$$('[data-close]').forEach(button=>button.addEventListener('click',()=>$('#'+button.dataset.close).close()));
$$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close()}));
$('#quick-task').addEventListener('click',()=>$('#entry-name').focus());
$('#quick-event').addEventListener('click',()=>{setMode('event');$('#entry-name').focus()});
$('#add-task-link').addEventListener('click',()=>{setMode('task');$('#entry-name').focus()});
$('#today-shortcut').addEventListener('click',()=>{selectedDate=new Date();selectedDate.setHours(0,0,0,0);view='today';render()});
$('#prev-day').addEventListener('click',()=>{selectedDate.setDate(selectedDate.getDate()-1);view='today';render()});
$('#next-day').addEventListener('click',()=>{selectedDate.setDate(selectedDate.getDate()+1);view='today';render()});
$$('[data-nav]').forEach(button=>button.addEventListener('click',()=>{
  view=button.dataset.nav; $$('[data-nav]').forEach(item=>item.classList.toggle('active',item===button)); render();
}));
$('#notification-shortcut').addEventListener('click',()=>{view='notifications';render();$('#notice-list').scrollIntoView({behavior:'smooth',block:'center'})});
$('#auth-button').addEventListener('click',async()=>{
  if(!auth)return toast('請先在 app.js 設定 firebaseConfig。');
  try { if(currentUser)await signOut(auth);else await signInWithPopup(auth,new GoogleAuthProvider()); }
  catch(error){console.error(error);toast(`Google 登入操作失敗：${error.message}`)}
});

// Keep the Gemini key only in this browser. Anyone using this browser profile can inspect it.
$('#gemini-key').value=localStorage.getItem(GEMINI_KEY_STORAGE)||'';
$('#gemini-key').addEventListener('change',()=>{
  const key=$('#gemini-key').value.trim();
  if(key)localStorage.setItem(GEMINI_KEY_STORAGE,key);else localStorage.removeItem(GEMINI_KEY_STORAGE);
});
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.8-flash-lite'];
const BUSY_RETRY_DELAY_MS = 2000;
const BUSY_FINAL_MESSAGE = '目前 Google AI 免費伺服器處於尖峰塞車時段，系統已自動重試但仍無回應，請稍後再試。';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function isBusyGeminiError(status, message) {
  return status === 503 || status === 429 || /high demand|overloaded/i.test(message || '');
}
async function callGeminiModel(model, apiKey, requestBody) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(requestBody)
  });
  let payload;
  try { payload = await response.json(); }
  catch { payload = {}; }
  if (!response.ok) {
    const message = payload.error?.message || `Gemini HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.busy = isBusyGeminiError(response.status, message);
    throw error;
  }
  return payload;
}
async function generateWithFallback(apiKey, requestBody) {
  let lastError = null;
  let sawBusyError = false;
  for (let modelIndex = 0; modelIndex < GEMINI_MODELS.length; modelIndex += 1) {
    const model = GEMINI_MODELS[modelIndex];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await callGeminiModel(model, apiKey, requestBody);
      } catch (error) {
        lastError = error;
        if (error.busy) {
          sawBusyError = true;
          if (attempt === 0) {
            $('#ai-status').textContent = '伺服器忙碌中，正在自動重試...';
            await sleep(BUSY_RETRY_DELAY_MS);
            continue;
          }
          break;
        }
        // The fallback model may not be enabled/available for this API key; skip it without retry.
        if (modelIndex > 0 && error.status === 404) break;
        // A first-model 404 also means this key cannot use the model; move on to the fallback.
        if (error.status === 404) break;
        throw error;
      }
    }
  }
  if (sawBusyError) {
    const error = new Error(BUSY_FINAL_MESSAGE);
    error.busyExhausted = true;
    throw error;
  }
  throw lastError || new Error('目前沒有可用的 Gemini 模型。');
}
$('#ai-form').addEventListener('submit', async event => {
  event.preventDefault();
  const apiKey = $('#gemini-key').value.trim();
  const prompt = $('#ai-prompt').value.trim();
  if (!apiKey) return toast('請先貼上自己的 Gemini API Key。');
  if (!prompt) return toast('請輸入想安排的事項。');
  localStorage.setItem(GEMINI_KEY_STORAGE, apiKey);
  const button = $('#ai-submit');
  button.disabled = true;
  $('#ai-status').textContent = 'AI 正在整理你的安排…';
  $('#ai-output').hidden = true;
  $('#ai-add-draft').hidden = true;
  aiDraft = null;
  try {
    const requestBody = {
      contents: [{ role: 'user', parts: [{ text: `你是行程整理助理。使用者輸入：${prompt}\n\n請用繁體中文回覆清楚、可執行的安排建議。若資訊不足，請標示需確認的時間，不要自行聲稱已建立行程。最後另附一個 JSON 物件，格式為 {"title":"簡短名稱","type":"task 或 event","startAt":"YYYY-MM-DDTHH:mm 或空字串","endAt":"YYYY-MM-DDTHH:mm 或空字串","dueAt":"YYYY-MM-DDTHH:mm 或空字串","category":"個人","reminderMinutes":10,"note":"備註"}。相對日期以今日 ${new Date().toLocaleDateString('sv-SE')} 為準，時間採 24 小時。` }] }],
      generationConfig: { temperature: 0.3 }
    };
    const payload = await generateWithFallback(apiKey, requestBody);
    const text = payload.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('\n') || '未取得 AI 回覆。';
    $('#ai-output').textContent = text;
    $('#ai-output').hidden = false;
    $('#ai-status').textContent = '建議草案已產生。請確認內容後再手動新增。';
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        aiDraft = JSON.parse(match[0]);
        $('#ai-add-draft').hidden = !aiDraft.title || !currentUser;
      } catch { aiDraft = null; }
    }
  } catch (error) {
    console.error('Gemini request failed:', error);
    $('#ai-status').textContent = error.busyExhausted ? BUSY_FINAL_MESSAGE : `AI 呼叫失敗：${error.message}`;
  } finally {
    button.disabled = false;
  }
});$('#ai-add-draft').addEventListener('click',async()=>{
  if(!aiDraft||!currentUser)return toast('請先登入，並確認 AI 草案內容。');
  try {
    const isEvent=aiDraft.type==='event';
    const now=new Date(), fallbackStart=localDateTime(new Date(now.getTime()+3600000));
    const data=isEvent?{type:'event',title:aiDraft.title,startAt:aiDraft.startAt||fallbackStart,endAt:aiDraft.endAt||localDateTime(new Date(new Date(fallbackStart).getTime()+3600000)),category:aiDraft.category||'個人',note:aiDraft.note||'',reminderMinutes:aiDraft.reminderMinutes??10,completed:false}:{type:'task',title:aiDraft.title,dueAt:aiDraft.dueAt||fallbackStart,category:aiDraft.category||'個人',reminderMinutes:aiDraft.reminderMinutes??10,completed:false};
    await createTask(data);toast('AI 草案已加入 Firestore');$('#ai-add-draft').hidden=true;aiDraft=null;
  } catch(error){toast(`新增草案失敗：${error.message}`)}
});
function checkReminders(){
  if(!currentUser)return;
  const now=Date.now();
  for(const task of tasks){if(task.completed||task.reminderMinutes==='none'||task.reminderMinutes==null)continue;
    const base=parseDate(task.type==='event'?task.startAt:task.dueAt).getTime();
    const at=base-Number(task.reminderMinutes)*60000,key=`${task.id}-${at}`;
    if(at<=now&&at>now-60000&&!firedReminders.has(key)){firedReminders.add(key);toast(`提醒：${task.title}`);}
  }
}
function validFirebaseConfig(config){return config.apiKey!=='PASTE_FIREBASE_API_KEY_HERE'&&config.projectId!=='PASTE_PROJECT_ID_HERE'&&config.appId!=='PASTE_FIREBASE_APP_ID_HERE';}
function startFirebase(){
  if(!validFirebaseConfig(firebaseConfig)){toast('請先在 app.js 填入 Firebase Web App 設定。');return;}
  try {
    app=initializeApp(firebaseConfig);auth=getAuth(app);db=getFirestore(app);
    onAuthStateChanged(auth,user=>{updateIdentity(user);listenForTasks(user);});
  } catch(error){console.error(error);toast(`Firebase 初始化失敗：${error.message}`)}
}
initializeDates();setMode('task');renderHeader();setAppEnabled(false);startFirebase();setInterval(checkReminders,30000);
