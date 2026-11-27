import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";

const API_BASE = (window.OWL_API_BASE || 'https://us-central1-finder-owl.cloudfunctions.net/api');

const firebaseConfig = {
  apiKey: "AIzaSyBEYKHQpy_VjmgjYIwQOPjXth1bghYsf9M",
  authDomain: "finder-owl.firebaseapp.com",
  projectId: "finder-owl",
  storageBucket: "finder-owl.firebasestorage.app",
  messagingSenderId: "1011347100861",
  appId: "1:1011347100861:web:24246f9a4eb24d812cd3d4"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// The Owl Watcher team's WhatsApp number lives in Firestore
// (configs/owlwatcher.teamPhone) and is served by GET /api/config. The value
// below is only used until that answer arrives or when the API is unreachable,
// so the button never leads to a dead wa.me link.
const FALLBACK_TEAM_PHONE = "919033406816";
let teamPhone = FALLBACK_TEAM_PHONE;

// The admin portal hands over the society it resolved for the signed-in
// administrator (request-context.js). A freshly opened tab may not have the
// Firebase session restored yet, and a page that only says "please log in"
// cannot name the society — so the hand-off seeds the page and the live
// session, when there is one, always wins.
const handOff = (window.OwRequestContext && window.OwRequestContext.load()) || null;

// The society the signed-in administrator belongs to. It comes from the
// Firestore `admins` record (via the API), never from the URL, so a request
// always names the correct society.
let assignedSociety = (handOff && handOff.society) || "";
let assignedSocietyId = (handOff && handOff.societyId) || "";
let requesterEmail = (handOff && handOff.email) || "";
// True once GET /api/admins/me confirmed the society for a live session.
let societyVerified = false;
// True once the page knows whose request it is (live session or hand-off).
let canSend = false;

function normalisePhone(value) {
    const digits = String(value || '').replace(/\D/g, '');
    // wa.me needs the country code: 10-digit Indian numbers are given +91.
    if (digits.length === 10) return `91${digits}`;
    return digits.length >= 11 ? digits : '';
}

async function fetchTeamPhone() {
    try {
        const res = await fetch(`${API_BASE}/config`);
        if (res.ok) {
            const data = await res.json().catch(() => ({}));
            const digits = normalisePhone(data && data.teamPhone);
            if (digits) teamPhone = digits;
        }
    } catch (err) {
        console.error("Failed to fetch the Owl Watcher team number, using the built-in one.", err);
    }
    return teamPhone;
}

async function fetchAssignedSociety(user) {
    try {
        const token = await user.getIdToken();
        const res = await fetch(`${API_BASE}/admins/me`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) return null;
        const data = await res.json().catch(() => ({}));
        const society = (data && data.society) || "";
        if (society) {
            assignedSociety = society;
            assignedSocietyId = (data && data.societyId) || "";
            societyVerified = true;
        } else if (handOff && handOff.society && (data.email || user.email) === handOff.email) {
            // Same administrator, no society stored on the record yet: keep the
            // hand-off rather than forgetting the society already resolved.
            assignedSociety = handOff.society;
            assignedSocietyId = handOff.societyId || assignedSocietyId;
        }
        if (data && data.email) requesterEmail = data.email;
        return data;
    } catch (err) {
        console.error("Could not load the signed-in administrator's society.", err);
        return null;
    }
}

// Opens the chat in a new tab (same context as the other Contact links) and
// falls back to a same-tab navigation when a popup blocker refuses it.
function openWhatsApp(url) {
    const opened = window.open(url, '_blank', 'noopener');
    if (!opened) window.location.href = url;
}

function showDeleteModal(title, message) {
    document.getElementById('deleteModalTitle').textContent = title;
    document.getElementById('deleteModalText').textContent = message;
    document.getElementById('deleteModal').style.display = 'block';
}

function showSocietyLabel() {
    const label = document.getElementById('societyLabel');
    if (!label) return;
    if (!assignedSociety) {
        label.textContent = "Society: could not be loaded";
    } else if (societyVerified) {
        label.textContent = requesterEmail
            ? `Society: ${assignedSociety} · ${requesterEmail}`
            : `Society: ${assignedSociety}`;
    } else {
        // Named by the admin portal this page was opened from.
        label.textContent = `Society: ${assignedSociety} · from your admin session`;
    }
    label.dataset.society = assignedSociety;
    label.dataset.societyId = assignedSocietyId;
}

function whatsappUrl(message) {
    return `https://wa.me/${teamPhone}?text=${message}`;
}

function buildRequestMessage(user, option, details) {
    const email = (user && user.email) || requesterEmail || "unknown";
    const lines = [
        "Hi Owl Watcher team, I would like to request data deletion.",
        "",
        `Society: ${assignedSociety || "(not loaded)"}`
    ];
    if (assignedSocietyId && assignedSocietyId !== assignedSociety) lines.push(`Society ID: ${assignedSocietyId}`);
    lines.push(`Request Type: ${option}`);
    lines.push(`Details: ${details || "N/A"}`);
    lines.push(`Requested by: ${email}`);
    return encodeURIComponent(lines.join("\n"));
}

// Keeps the button in step with what the page knows: a live session or the
// admin portal's hand-off. Anything else stays disabled with an explanation.
// `pending` is the first paint, before Firebase has answered, so a signed-in
// admin opening the page directly is not told to log in.
function render(user, options = {}) {
    const btn = document.getElementById('submitDeleteReq');
    const label = document.getElementById('societyLabel');
    canSend = !!(user || (handOff && (handOff.society || handOff.email)));
    showSocietyLabel();
    if (!btn) return;
    btn.disabled = !canSend;
    if (canSend || !label) return;
    if (options.pending) {
        label.textContent = "Checking your admin session…";
        return;
    }
    label.textContent = "Please log in as a society admin to send a request. Open the Admin portal, sign in, then use its Danger zone.";
    label.dataset.society = "";
}

function submit() {
    if (!canSend) return;
    const option = document.getElementById('deleteOption').value;
    const details = document.getElementById('details').value.trim();
    if (option === 'Specific Vehicle' && !details) {
        showDeleteModal('Enter the vehicle number', 'Enter the vehicle number you want removed, or choose another option.');
        return;
    }
    const message = buildRequestMessage(auth.currentUser, option, details);
    showDeleteModal('WhatsApp opened', 'Send the message to complete the request. Our team will process it.');
    openWhatsApp(whatsappUrl(message));
}

// One listener for the page's lifetime: onAuthStateChanged can fire more than
// once, and re-attaching would open WhatsApp twice.
document.getElementById('submitDeleteReq')?.addEventListener('click', submit);

// Paint from the hand-off straight away: the society is already known when the
// page was opened from the admin portal, whatever Firebase is still doing.
render(null, { pending: !canSend });

onAuthStateChanged(auth, async (user) => {
    if (user) {
        requesterEmail = user.email || requesterEmail;
        await Promise.all([fetchTeamPhone(), fetchAssignedSociety(user)]);
        render(user);
        return;
    }

    if (handOff && (handOff.society || handOff.email)) {
        // Signed-out tab opened from the admin portal: still name the society and
        // keep the request one click away.
        requesterEmail = handOff.email || requesterEmail;
        await fetchTeamPhone();
        render(null);
        return;
    }

    render(null);
});

// Exposed for tests and for the page's own debugging.
window.OwDeleteRequest = {
    buildRequestMessage,
    fetchTeamPhone,
    fetchAssignedSociety,
    normalisePhone,
    render,
    getTeamPhone: () => teamPhone,
    getAssignedSociety: () => assignedSociety,
    getHandOff: () => handOff
};
