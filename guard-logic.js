import { auth, authenticatedFetch } from "./app.js";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const API_BASE = (window.OWL_API_BASE || 'https://us-central1-finder-owl.cloudfunctions.net/api');
const NG_HEADERS = { 'ngrok-skip-browser-warning': 'true' };
let assignedSociety = "";

// Only addresses registered in Firestore `guards` may use this portal, and only
// for their own guard profile. Checked before Firebase auth (so no session is
// created for a stranger) and again after sign-in through the API.
const NOT_GUARD_MESSAGE = "This email is not registered as a security guard. Ask your society admin to add you as a guard, or sign in with your guard email.";
const ADMIN_NOT_GUARD_MESSAGE = "This email is registered as a society admin, not a guard. Please use the Admin portal to sign in.";

function isPlausibleEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Returns 'admin' | 'master' | 'guard' | null. A failed lookup returns null so
// the caller stays on the sign-in card instead of guessing.
async function lookupStaffRole(email) {
    const res = await authenticatedFetch(`${API_BASE}/auth/staff-role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
    });
    if (!res.ok) throw new Error(`Staff check failed (${res.status})`);
    const data = await res.json().catch(() => ({}));
    return data && data.role ? String(data.role) : null;
}

window.OwGuardAuth = { lookupStaffRole, isPlausibleEmail, NOT_GUARD_MESSAGE, ADMIN_NOT_GUARD_MESSAGE };

window.closeModal = () => { document.getElementById('customModal').style.display = 'none'; };
window.showModal = (msg) => {
    // textContent, not innerText: the message must be real text in every
    // renderer (jsdom, older WebViews), not only in browsers that lay out.
    document.getElementById('modalMessage').textContent = msg;
    document.getElementById('customModal').style.display = 'flex';
};

// Mobile menu toggle is handled by menu.js

function setSignedOutView() {
    const login = document.getElementById('login-section');
    const portal = document.getElementById('portalSection');
    const logout = document.getElementById('logoutBtn');
    if (login) login.style.display = 'block';
    if (portal) portal.style.display = 'none';
    if (logout) logout.style.display = 'none';
}

async function initializeGuardPortal(email) {
    try {
        const currentUser = auth.currentUser;
        if (currentUser) {
            await currentUser.getIdToken(true);
        }

        const res = await authenticatedFetch(`${API_BASE}/guards?email=${encodeURIComponent(email)}`);
        const guardsList = await res.json();
        
        if (!Array.isArray(guardsList) || guardsList.length === 0) {
            await signOut(auth);
            setSignedOutView();
            window.showModal(NOT_GUARD_MESSAGE);
            return;
        }
        
        assignedSociety = guardsList[0].society; 
        
        const societyRes = await authenticatedFetch(`${API_BASE}/guards?society=${encodeURIComponent(assignedSociety)}`);
        const societyGuards = await societyRes.json();
        const select = document.getElementById('guardSelect');
        
        if (select) {
            select.innerHTML = "";
            societyGuards.forEach(data => {
                select.innerHTML += `<option value="${data.name}" data-phone="${data.phone}">${data.name}</option>`;
            });
        }
        
        document.getElementById('login-section').style.display = 'none';
        document.getElementById('portalSection').style.display = 'block';
        document.getElementById('logoutBtn').style.display = 'block';
    } catch (e) { 
        console.error("Portal load error:", e);
        // A guard-only 403/404 (e.g. an admin account) must not leave the portal
        // open; fall back to the sign-in card.
        setSignedOutView();
        window.showModal("Error loading portal profile data.");
    }
}

onAuthStateChanged(auth, async (user) => {
    if (user) {
        await initializeGuardPortal(user.email);
    } else {
        setSignedOutView();
    }
});

document.getElementById('loginBtn')?.addEventListener('click', async () => {
    const emailInput = document.getElementById('email');
    const passInput = document.getElementById('pass');
    if (!emailInput || !passInput) return;

    const email = emailInput.value.trim().toLowerCase();
    const pass = passInput.value.trim();

    // Check for empty fields
    if (!email || !pass) {
        window.showModal("Pls enter email id and password");
        return;
    }
    
    if (!isPlausibleEmail(email)) {
        window.showModal("Please enter a valid email id.");
        return;
    }

    // Is this address actually a guard? Checked before the password is sent, so
    // an ordinary (or admin) account is turned away with a clear message instead
    // of briefly signing in.
    const loginBtn = document.getElementById('loginBtn');
    if (loginBtn) loginBtn.disabled = true;
    try {
        const role = await lookupStaffRole(email);
        if (role === 'admin' || role === 'master') {
            window.showModal(ADMIN_NOT_GUARD_MESSAGE);
            return;
        }
        if (role !== 'guard') {
            window.showModal(NOT_GUARD_MESSAGE);
            return;
        }
    } catch (e) {
        window.showModal("Could not check whether this email is a guard. Check your connection and try again.");
        return;
    } finally {
        if (loginBtn) loginBtn.disabled = false;
    }

    try {
        console.log("Attempting guard login for:", email);
        await signInWithEmailAndPassword(auth, email, pass);
        window.showModal("Login successful!");
    } catch (e) {
        console.error("Firebase Guard Login Error:", e);

        if (e.code === 'auth/invalid-credential' || e.code === 'auth/user-not-found' || e.code === 'auth/wrong-password') {
            window.showModal("Wrong email or password entered");
        } else if (e.message?.includes("App Check token is invalid")) {
            window.showModal("Access Denied: App Check verification failed.");
        } else {
            window.showModal("Login failed: " + (e.code || "Error"));
        }
    }
});

document.getElementById('forgotPasswordBtn')?.addEventListener('click', async () => {
    const emailInput = document.getElementById('email');
    const email = emailInput ? emailInput.value.trim().toLowerCase() : "";
    if (!email) return window.showModal("Pls enter email id");

    try {
        await sendPasswordResetEmail(auth, email);
    } catch (_) {
        // Avoid revealing whether the address is registered as a guard.
    }
    window.showModal("If an account is registered for that email, a password reset link will be sent.");
});

document.getElementById('activateBtn')?.addEventListener('click', async () => {
    const select = document.getElementById('guardSelect');
    if (!select || !assignedSociety) return;
    
    try {
        const selectedOption = select.options[select.selectedIndex];
        
        await authenticatedFetch(`${API_BASE}/societies/${encodeURIComponent(assignedSociety)}/active-guard`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                activeGuardName: select.value, 
                activeGuardPhone: selectedOption ? selectedOption.dataset.phone : "" 
            })
        });
        
        window.showModal("Duty activated successfully for " + assignedSociety);
    } catch (e) {
        console.error("Activation error:", e);
        window.showModal("Failed to activate duty.");
    }
});

document.getElementById('searchBtn')?.addEventListener('click', async () => {
    const vNum = document.getElementById('vSearch').value.trim().toUpperCase();
    if (!vNum) return window.showModal("Enter a valid vehicle number.");

    try {
        const res = await authenticatedFetch(`${API_BASE}/vehicles?societyName=${encodeURIComponent(assignedSociety)}&vehicleNumber=${encodeURIComponent(vNum)}`);
        const vehicles = await res.json();
        const resultDiv = document.getElementById('result');
        
        if (vehicles.length > 0) {
            const d = vehicles[0];
            resultDiv.innerHTML = `<div style="font-family: sans-serif;">Flat/Name: <b>${d.flatNumber}</b><br><a href="tel:${d.mobileNumber}">📞 Call: ${d.mobileNumber}</a></div>`;
        } else {
            window.showModal("No vehicle found for this society.");
            resultDiv.innerHTML = "";
        }
    } catch (e) {
        window.showModal("Search error.");
    }
});

document.getElementById('logoutBtn')?.addEventListener('click', async () => { 
    await signOut(auth);
    location.reload(); 
});

