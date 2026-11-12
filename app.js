import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { getDatabase, ref, onValue, set } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-database.js';

// Identificadores publicos de la app web Firebase; NO agregar contrasenas ni tokens aqui.
const firebaseConfig = {
  apiKey: 'AIzaSyA6gpJD3zRSoGZwjH-CVUCkWB4NmkwAE64',
  authDomain: 'casa-inteligente-con-esp32.firebaseapp.com',
  databaseURL: 'https://casa-inteligente-con-esp32-default-rtdb.firebaseio.com',
  projectId: 'casa-inteligente-con-esp32',
  storageBucket: 'casa-inteligente-con-esp32.firebasestorage.app',
  messagingSenderId: '54925117779',
  appId: '1:54925117779:web:488eea6b78b97bf6afb9a6'
};

// UID del administrador autorizado para escribir /domotica/comandos en tus reglas.
// Esto es solo una ayuda de interfaz; las reglas de Firebase son la seguridad real.
const ADMIN_UID = 'qcrxzhcxv8NAhPfTplyySNg3QUV2';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const $ = (id) => document.getElementById(id);
const ledNames = ['led1', 'led2', 'led3', 'led4'];
const ledCards = Object.fromEntries(ledNames.map(name => [name, document.querySelector(`[data-led="${name}"]`)]));

let unsubscribers = [];
let states = null;
let commands = null;
let streamReady = {states: false, commands: false};
let currentUser = null;
let pending = {};
let databaseError = '';

function showError(where, message) {
  const el = $(where);
  el.textContent = message;
  el.hidden = !message;
}
function connection(label, detail, kind = '') {
  $('connectionLabel').textContent = label;
  $('connectionDetail').textContent = detail;
  $('connectionDot').className = `connection-dot ${kind}`;
}
function authErrorMessage(error) {
  const codes = {
    'auth/invalid-credential': 'Correo o contrasena incorrectos.',
    'auth/invalid-email': 'El formato del correo no es valido.',
    'auth/too-many-requests': 'Demasiados intentos. Intenta mas tarde.',
    'auth/network-request-failed': 'No se pudo conectar. Verifica Internet.',
    'auth/user-disabled': 'Esta cuenta esta deshabilitada.',
    'auth/unauthorized-domain': 'Dominio no autorizado. Revisa Firebase Authentication.'
  };
  return codes[error.code] || `No se pudo iniciar sesion (${error.code || 'error desconocido'}).`;
}
function resetSubscriptions() {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  for (const value of Object.values(pending)) clearTimeout(value.timeout);
  pending = {};
  states = null;
  commands = null;
  databaseError = '';
  streamReady = { states: false, commands: false };
}
function render() {
  for (const name of ledNames) {
    const card = ledCards[name];
    const state = states?.[name];
    const command = commands?.[name];
    const known = typeof state === 'boolean';
    const waiting = !!pending[name];
    const pill = card.querySelector('[data-state]');
    const detail = card.querySelector('[data-detail]');
    const button = card.querySelector('[data-toggle]');
    card.classList.toggle('on', known && state);
    pill.textContent = known ? (state ? 'Encendido' : 'Apagado') : 'Sin datos';
    detail.textContent = waiting ? 'Orden enviada; esperando confirmación…' : !known ? 'Sin lectura del ESP32' : (typeof command === 'boolean' && command !== state ? 'Orden y estado todavía no coinciden' : 'Estado informado por el ESP32');
    button.disabled = !currentUser || !streamReady.states || !streamReady.commands || !known || waiting || !!databaseError;
    button.textContent = waiting ? 'Confirmando…' : !known ? 'Esperando datos' : state ? 'Apagar luz' : 'Encender luz';
  }
  if (typeof states?.lluvia === 'boolean') $('rainStatus').textContent = states.lluvia ? 'Lluvia detectada' : 'Sin lluvia';
  else $('rainStatus').textContent = 'Sin datos';
  const roof = states?.techo;
  const labels = { abierto:'Abierto', cerrado:'Cerrado', abriendo:'Abriendo…', cerrando:'Cerrando…', desconocido:'Desconocido', error:'Error de movimiento' };
  $('roofStatus').textContent = typeof roof === 'string' ? (labels[roof] || 'Estado no reconocido') : 'Sin datos';
  // Dynamic presentation only; no changes to Firebase commands.
  const rainCard = $('rainStatus').closest('.monitor-card');
  const roofCard = $('roofStatus').closest('.monitor-card');
  rainCard.classList.toggle('is-raining', states?.lluvia === true);
  roofCard.classList.toggle('is-closed', roof === 'cerrado' || roof === 'cerrando');
  roofCard.classList.toggle('is-error', roof === 'error');
}
function watchDatabase() {
  const onReadError = (error) => {
    databaseError = error.message || 'Sin permisos para consultar Realtime Database';
    showError('dashboardError', `No se pudieron leer los datos: ${databaseError}`);
    connection('Error de lectura', 'Verifica las reglas de Firebase', 'bad');
    render();
  };
  unsubscribers.push(onValue(ref(db, 'domotica/estados'), snapshot => {
    states = snapshot.val() || {};
    streamReady.states = true;
    $('lastData').textContent = new Date().toLocaleString('es-BO');
    if (!databaseError) connection('Datos de Firebase recibidos', 'Esto no verifica que el ESP32 esté en línea', 'good');
    for (const [name, entry] of Object.entries(pending)) {
      if (states?.[name] === entry.expected) {
        clearTimeout(entry.timeout);
        delete pending[name];
      }
    }
    render();
  }, onReadError));
  unsubscribers.push(onValue(ref(db, 'domotica/comandos'), snapshot => {
    commands = snapshot.val() || {};
    streamReady.commands = true;
    render();
  }, onReadError));
}

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('loginError', '');
  const button = $('loginBtn');
  button.disabled = true;
  button.textContent = 'Verificando acceso…';
  try {
    const result = await signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value);
    if (result.user.uid !== ADMIN_UID) {
      await signOut(auth);
      showError('loginError', 'Esta cuenta no es la administradora autorizada para controlar la casa.');
    }
  } catch (error) {
    showError('loginError', authErrorMessage(error));
  } finally {
    $('password').value = '';
    button.disabled = false;
    button.textContent = 'Entrar al panel →';
  }
});
$('logoutBtn').addEventListener('click', () => signOut(auth));
for (const name of ledNames) {
  ledCards[name].querySelector('[data-toggle]').addEventListener('click', async () => {
    if (!currentUser || currentUser.uid !== ADMIN_UID || databaseError || pending[name] || !streamReady.states || !streamReady.commands || typeof states?.[name] !== 'boolean') return;
    const expected = !states[name];
    const timeout = setTimeout(() => {
      if (pending[name]?.expected === expected) {
        delete pending[name];
        showError('dashboardError', `No llegó confirmación del ESP32 para ${name}. Revisa la conexión del dispositivo; el estado mostrado sigue siendo el último recibido.`);
        render();
      }
    }, 15000);
    pending[name] = { expected, timeout };
    showError('dashboardError', '');
    render();
    try {
      await set(ref(db, `domotica/comandos/${name}`), expected);
    } catch (error) {
      clearTimeout(timeout);
      delete pending[name];
      showError('dashboardError', `No se pudo enviar la orden a ${name}: ${error.message}`);
      render();
    }
  });
}

onAuthStateChanged(auth, async user => {
  resetSubscriptions();
  currentUser = user?.uid === ADMIN_UID ? user : null;
  if (user && !currentUser) {
    await signOut(auth);
    showError('loginError', 'Acceso denegado: esta cuenta no es el administrador autorizado.');
    return;
  }
  $('loginView').hidden = !!currentUser;
  $('dashboardView').hidden = !currentUser;
  $('account').hidden = !currentUser;
  if (!currentUser) return;
  $('accountEmail').textContent = currentUser.email || 'Administrador';
  showError('dashboardError', '');
  connection('Conectando a Firebase…', 'Cargando comandos y estados');
  render();
  watchDatabase();
});
