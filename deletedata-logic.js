import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";

const API_BASE = "https://api.owlwatcher.tech/api";

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

// Default fallback phone number
let teamPhone = "919033406816";

async function fetchTeamPhone() {
    try {
        const res = await fetch(`${API_BASE}/config`);
        if (res.ok) {
            const data = await res.json();
            if (data.teamPhone) {
                teamPhone = data.teamPhone.replace(/\D/g, '');
            }
        }
    } catch (err) {
        console.error("Failed to fetch dynamic master admin phone, using fallback.", err);
    }
}

onAuthStateChanged(auth, async (user) => {
    await fetchTeamPhone();

    const btn = document.getElementById('submitDeleteReq');
    if (btn) {
        btn.addEventListener('click', () => {
            if (!user) return alert("Please log in.");

            const option = document.getElementById('deleteOption').value;
            const details = document.getElementById('details').value || "N/A";
            const email = user.email;

            const message = encodeURIComponent(`Hi, I would like to request data deletion.
            
Request Type: ${option}
Details: ${details}
User Email: ${email}`);

            window.location.href = `https://wa.me/${teamPhone}?text=${message}`;
        });
    }
});