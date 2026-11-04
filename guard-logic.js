import { auth, authenticatedFetch } from "./app.js";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const API_BASE = "https://api.owlwatcher.tech/api";
const NG_HEADERS = { 'ngrok-skip-browser-warning': 'true' };
let assignedSociety = "";

window.closeModal = () => { document.getElementById('customModal').style.display = 'none'; };
window.showModal = (msg) => {
    document.getElementById('modalMessage').innerText = msg;
    document.getElementById('customModal').style.display = 'flex'; 
};

// Mobile menu toggle is handled by menu.js

async function initializeGuardPortal(email) {
    try {
        const currentUser = auth.currentUser;
        if (currentUser) {
            await currentUser.getIdToken(true);
        }

        const res = await authenticatedFetch(`${API_BASE}/guards?email=${encodeURIComponent(email)}`);
        const guardsList = await res.json();
        
        if (guardsList.length === 0) {
            await signOut(auth);
            window.showModal("Not Registered as Security Guard");
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
        window.showModal("Error loading portal profile data.");
    }
}

onAuthStateChanged(auth, async (user) => {
    if (user) {
        await initializeGuardPortal(user.email);
    } else {
        document.getElementById('login-section').style.display = 'block';
        document.getElementById('portalSection').style.display = 'none';
        document.getElementById('logoutBtn').style.display = 'none';
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

    if (!email) {
        window.showModal("Pls enter email id");
        return;
    }

    try {
        // 1. Verify with backend if this email is registered as a guard
        const res = await authenticatedFetch(`${API_BASE}/guards?email=${encodeURIComponent(email)}`);
        const guards = await res.json();

        // 2. Check if any guard record was found (handles list or object)
        let exists = res.ok && guards;
        if (Array.isArray(guards)) {
            exists = exists && guards.length > 0;
        } else if (guards && typeof guards === 'object') {
            exists = exists && (guards.society || guards.email || guards.id);
        } else {
            exists = false;
        }

        if (!exists) {
            window.showModal("No guard registered with entered emailid");
            return;
        }

        // 3. Trigger reset email
        await sendPasswordResetEmail(auth, email);
        window.showModal("Password reset link sent to your email!");
    } catch (error) {
        console.error("Error sending password reset email:", error);
        window.showModal("No guard registered with entered emailid");
    }
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

