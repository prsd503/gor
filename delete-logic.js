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
// below is only used until that answer arrives or when the API is unreachable.
const FALLBACK_TEAM_PHONE = "919033406816";
let owlWatcherTeamPhone = FALLBACK_TEAM_PHONE;

// The society the signed-in administrator belongs to, read from the Firestore
// `admins` record through the API so the request always names the right one.
let assignedSociety = "";
let assignedSocietyId = "";

async function fetchTeamPhone() {
    try {
        const res = await fetch(`${API_BASE}/config`);
        if (res.ok) {
            const data = await res.json();
            const digits = String((data && data.teamPhone) || '').replace(/\D/g, '');
            if (digits.length >= 10) owlWatcherTeamPhone = digits;
        }
    } catch (err) {
        console.error("Failed to fetch dynamic master admin phone, using fallback.", err);
    }
}

async function fetchAssignedSociety(user) {
    try {
        const token = await user.getIdToken();
        const res = await fetch(`${API_BASE}/admins/me`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) return null;
        const data = await res.json().catch(() => ({}));
        assignedSociety = (data && data.society) || "";
        assignedSocietyId = (data && data.societyId) || "";
        return data;
    } catch (err) {
        console.error("Could not load the signed-in administrator's society.", err);
        return null;
    }
}

function showSocietyLabel() {
    const label = document.getElementById('societyLabel');
    if (!label) return;
    label.textContent = assignedSociety ? `Society: ${assignedSociety}` : "Society: could not be loaded";
    label.dataset.society = assignedSociety;
    label.dataset.societyId = assignedSocietyId;
}

function buildAccountDeleteMessage(user) {
    const lines = [
        "Hi Owl Watcher team, I am requesting permanent closure of my Owl Watcher admin account.",
        "",
        `Society: ${assignedSociety || "(not loaded)"}`
    ];
    if (assignedSocietyId && assignedSocietyId !== assignedSociety) lines.push(`Society ID: ${assignedSocietyId}`);
    lines.push(`Account email: ${(user && user.email) || "unknown"}`);
    lines.push("Please process my data export and account closure.");
    return encodeURIComponent(lines.join("\n"));
}

// Opens the chat in a new tab (same context as the other Contact links) and
// falls back to a same-tab navigation when a popup blocker refuses it.
function openWhatsApp(url) {
    const opened = window.open(url, '_blank', 'noopener');
    if (!opened) window.location.href = url;
}

onAuthStateChanged(auth, async (user) => {
    const btn = document.getElementById('submitDeleteBtn');
    if (!user) {
        if (btn) btn.disabled = true;
        const label = document.getElementById('societyLabel');
        if (label) {
            label.textContent = "Please log in as a society admin to send a request.";
            label.dataset.society = "";
        }
        return;
    }

    await Promise.all([fetchTeamPhone(), fetchAssignedSociety(user)]);
    showSocietyLabel();

    if (btn) {
        btn.disabled = false;
        btn.addEventListener('click', () => {
            const message = buildAccountDeleteMessage(user);
            openWhatsApp(`https://wa.me/${owlWatcherTeamPhone}?text=${message}`);
        });
    }
});

// Exposed for tests and for the page's own debugging.
window.OwAccountDelete = {
    buildAccountDeleteMessage,
    fetchTeamPhone,
    fetchAssignedSociety,
    getTeamPhone: () => owlWatcherTeamPhone,
    getAssignedSociety: () => assignedSociety
};
