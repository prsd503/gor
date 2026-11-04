import { auth, authenticatedFetch } from "./app.js";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { Filesystem, Directory, Encoding } from 'https://cdn.jsdelivr.net/npm/@capacitor/filesystem@latest/+esm';
import { Share } from 'https://cdn.jsdelivr.net/npm/@capacitor/share@latest/+esm';

const API_BASE_URL = "https://api.owlwatcher.tech/api";
const NG_HEADERS = { 'ngrok-skip-browser-warning': 'true' };

let assignedSociety = "";
let teamPhone = "919033406816";
let isMasterAdminUser = false;

// --- UI & Global Helpers ---
window.showModal = (msg, showConfirm = false) => {
    document.getElementById('modalMessage').innerText = msg;
    const confirmBtn = document.getElementById('confirmDeleteBtn');
    if (confirmBtn) confirmBtn.style.display = showConfirm ? 'inline-block' : 'none';
    document.getElementById('customModal').style.display = 'block';
};
window.closeModal = () => { document.getElementById('customModal').style.display = 'none'; };

window.downloadCSV = async function(content, filename) {
    try {
        const isNative = window.location.href.includes("capacitor://") || window.Capacitor?.isNativePlatform();

        if (isNative) {
            const tempFile = await Filesystem.writeFile({
                path: filename,
                data: content,
                directory: Directory.Cache,
                encoding: Encoding.UTF8
            });

            await Share.share({
                title: filename,
                url: tempFile.uri,
                dialogTitle: `Download ${filename}`
            });
        } else {
            const base64Data = btoa(unescape(encodeURIComponent(content)));
            const dataUri = `data:text/csv;charset=utf-8;base64,${base64Data}`;

            const link = document.createElement("a");
            link.href = dataUri;
            link.setAttribute('download', filename);
            link.style.display = 'none';

            document.body.appendChild(link);
            link.click();

            setTimeout(() => {
                document.body.removeChild(link);
            }, 100);
        }
    } catch (err) {
        console.error("Download Error:", err);
        window.showModal("Download Error: " + (err.message || err));
    }
};

let owlWatcherTeamPhone = "919033406816";

async function fetchTeamPhone() {
    try {
        const res = await fetch(`${API_BASE_URL}/config`, {
            headers: { 'ngrok-skip-browser-warning': 'true' }
        });
        if (res.ok) {
            const data = await res.json();
            if (data.teamPhone) {
                owlWatcherTeamPhone = data.teamPhone.replace(/\D/g, '');
            }
        }
    } catch (err) {
        console.error("Failed to fetch dynamic master admin phone, using fallback.", err);
    }
}

async function updateContactUsWhatsAppLink() {
    try {
        await fetchTeamPhone();

        const whatsappLinks = document.querySelectorAll('a[href*="wa.me"]');
        whatsappLinks.forEach(link => {
            const urlObj = new URL(link.href);
            link.href = `https://wa.me/${owlWatcherTeamPhone}${urlObj.search}`;
        });
    } catch (err) {
        console.error("Failed to fetch team phone for WhatsApp link:", err);
    }
}

window.addEventListener("DOMContentLoaded", async () => {
    await updateContactUsWhatsAppLink();

    document.getElementById("logoutBtn")?.addEventListener("click", () => {
        localStorage.removeItem("adminLoggedIn");
        localStorage.removeItem("isAdminMaster");
        document.getElementById("login-section").style.display = "block";
        document.getElementById("search-section").style.display = "none";
        document.getElementById("data-section").style.display = "none";
        const masterPanel = document.getElementById("master-admin-panel");
        if (masterPanel) masterPanel.style.display = "none";
        const spinSection = document.getElementById("masterAdminSpinSection");
        if (spinSection) spinSection.style.display = "none";
    });
});


async function fetchSocietySpins() {
    const societyName = document.getElementById('adminSocietyQuery').value.trim();
    const resultDiv = document.getElementById('spinStatsResult');
    
    if (!societyName) {
        resultDiv.innerText = "Please enter a society name.";
        return;
    }

    resultDiv.innerHTML = "Fetching stats...";

    try {
        const res = await fetch(`https://api.owlwatcher.tech/api/contest/spinstats?societyName=${encodeURIComponent(societyName)}`, {
            headers: { 'ngrok-skip-browser-warning': 'true' }
        });
        
        if (res.ok) {
            const data = await res.json();
            
            const lifetime = data.totalSpins !== undefined ? data.totalSpins : (data.totalLifetimeSpins || 0);
            const daily = data.totalDaySpins !== undefined ? data.totalDaySpins : 0;
            const monthly = data.totalMonthSpins !== undefined ? data.totalMonthSpins : 0;
            const winnerFlat = data.winnerFlat || "None yet"; // 👈 Pulls from backend response
            
            resultDiv.innerHTML = `
                🏢 <b>Society:</b> ${data.societyName || societyName}<br>
                🏆 <b>Latest Winner Flat:</b> <span style="color:#2e7d32; font-weight:bold;">${winnerFlat}</span><br>
                ♾️ <b>Total Lifetime Spins:</b> <span style="color:#d32f2f;">${lifetime}</span><br>
                📅 <b>Spins Today:</b> <span style="color:#d32f2f;">${daily}</span><br>
                🗓️ <b>Spins This Month:</b> <span style="color:#d32f2f;">${monthly}</span>
            `;
        } else {
            resultDiv.innerText = "Society data not found or invalid response.";
        }
    } catch (err) {
        console.error("Spin Stats Error:", err);
        resultDiv.innerText = "Error fetching statistics.";
    }
}



// --- Security Guard Management Logic ---
document.getElementById('searchGuardBtn')?.addEventListener('click', async () => {
    const searchName = document.getElementById('searchGuardName').value.trim().toLowerCase();
    if (!searchName) return window.showModal("Please enter a guard name to search.");

    try {
        const res = await authenticatedFetch(`${API_BASE_URL}/guards?society=${encodeURIComponent(assignedSociety)}&name_lower=${encodeURIComponent(searchName)}`);
        const guards = await res.json();

        if (guards.length === 0) {
            window.showModal("No guard found with that name.");
            return;
        }

        const data = guards[0];
        document.getElementById('gEmail').value = data.email || data.id;
        document.getElementById('gName').value = data.name || "";
        document.getElementById('gPhone').value = data.phone || "";
        window.showModal("Guard details loaded into form.");
    } catch (err) {
        window.showModal("Error searching for guard.");
        console.error(err);
    }
});

document.getElementById('addGuardBtn')?.addEventListener('click', async () => {
    const email = document.getElementById('gEmail').value.trim().toLowerCase();
    const name = document.getElementById('gName').value.trim();
    const phone = document.getElementById('gPhone').value.trim();

    if (!email || !name) return window.showModal("Guard Email and Name are required.");

    try {
        const nameLower = name.toLowerCase();
        const res = await authenticatedFetch(`${API_BASE_URL}/guards?society=${encodeURIComponent(assignedSociety)}&name_lower=${encodeURIComponent(nameLower)}`);
        const guards = await res.json();

        let targetDocId = email; 
        if (guards.length > 0) {
            targetDocId = guards[0].id;
        }

        await authenticatedFetch(`${API_BASE_URL}/guards`, {
            method: 'POST',
            body: JSON.stringify({ targetDocId, email, name, name_lower: nameLower, phone, society: assignedSociety })
        });

        window.showModal("Guard saved successfully!");
    } catch (err) {
        window.showModal("Failed to save guard details.");
    }
});

document.getElementById('deleteGuardBtn')?.addEventListener('click', async () => {
    const email = document.getElementById('gEmail').value.trim().toLowerCase();
    if (!email) return window.showModal("Please specify or search the guard email to delete.");

    try {
        await authenticatedFetch(`${API_BASE_URL}/guards/${email}`, { method: 'DELETE' });
        window.showModal("Guard deleted successfully.");
        document.getElementById('gEmail').value = "";
        document.getElementById('gName').value = "";
        document.getElementById('gPhone').value = "";
    } catch (err) {
        window.showModal("Failed to delete guard record.");
    }
});

// --- Vehicle Registration Logic ---
const vehicleForm = document.getElementById("vehicleForm");
if (vehicleForm) {
    vehicleForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const submitBtn = e.target.querySelector("button[type='submit']");
        const originalBtnText = submitBtn.innerHTML;
        
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<div class="loading-spinner"></div> Registering...';

        const flatNumber = document.getElementById("flatSelect").value;
        const vehicleNumber = document.getElementById("vehicleNumber").value.trim().toUpperCase();
        const residentType = document.getElementById("residentTypeSelect")?.value || "Owner";
        const mobileNumber = document.getElementById("mobileNumber").value.trim();
        const vehicleType = document.getElementById("vehicleType").value;
        const targetSociety = societyData.name || societyId;
        
        try {
            const res = await authenticatedFetch(`${API_BASE_URL}/vehicles?societyName=${encodeURIComponent(targetSociety)}&vehicleNumber=${encodeURIComponent(vehicleNumber)}`);
            const existing = await res.json();

            if (existing.length > 0) {
                showModal("<p>❌ <b>Duplicate Entry</b><br>This vehicle number is already registered for this society.</p>");
                return;
            }

            const flatRes = await authenticatedFetch(`${API_BASE_URL}/vehicles?societyName=${encodeURIComponent(targetSociety)}`);
            const allVehicles = await flatRes.json();
            const flatVehicles = allVehicles.filter(v => v.flatNumber === flatNumber);

            let current4WheelerCount = 0;
            let current2WheelerCount = 0;

            flatVehicles.forEach(data => {
                if (data.vehicleType === "4-Wheeler") current4WheelerCount++;
                if (data.vehicleType === "2-Wheeler") current2WheelerCount++;
            });

            const max4Wheeler = societyData.max4Wheeler !== undefined ? societyData.max4Wheeler : 1;
            const max2Wheeler = societyData.max2Wheeler !== undefined ? societyData.max2Wheeler : 2;

            if (vehicleType === "4-Wheeler" && current4WheelerCount >= max4Wheeler) {
                showModal(`<p>⚠️ Limit Reached! Only <b>${max4Wheeler}</b> Four-Wheeler(s) are allowed per flat.</p>`);
                return;
            }

            if (vehicleType === "2-Wheeler" && current2WheelerCount >= max2Wheeler) {
                showModal(`<p>⚠️ Limit Reached! Only <b>${max2Wheeler}</b> Two-Wheeler(s) are allowed per flat.</p>`);
                return;
            }

            await authenticatedFetch(`${API_BASE_URL}/vehicles`, {
                method: 'POST',
                body: JSON.stringify({
                    vehicleNumber,
                    flatNumber,
                    residentType,
                    mobileNumber,
                    vehicleType,
                    societyName: targetSociety
                })
            });

            showModal("<p>✅ Vehicle registered successfully!</p>");
            setTimeout(() => window.location.href = "index.html", 1500);
        } catch (err) {
            console.error(err);
            showModal("<p>❌ Error saving entry. Try again.</p>");
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
        }
    });
}

// --- Vehicle Search Logic ---
document.getElementById('adminSearchBtn')?.addEventListener('click', async () => {
    const searchVal = document.getElementById('adminSearch').value.trim().toUpperCase();
    const resultsDiv = document.getElementById('admin-results');
    if (!searchVal) return window.showModal("Please enter a vehicle number to search.");

    resultsDiv.innerHTML = "Searching...";
    try {
        const res = await authenticatedFetch(`${API_BASE_URL}/vehicles?societyName=${encodeURIComponent(assignedSociety)}&vehicleNumber=${encodeURIComponent(searchVal)}`);
        const vehicles = await res.json();
        
        if (vehicles.length === 0) {
            resultsDiv.innerHTML = "<p>No vehicle found.</p>";
            return;
        }

        window.deleteVehicleDoc = async (docId) => {
            try {
                await authenticatedFetch(`${API_BASE_URL}/vehicles/${docId}`, { method: 'DELETE' });
                window.showModal("Vehicle deleted from registry.");
                document.getElementById('admin-results').innerHTML = "";
            } catch (err) {
                window.showModal("Failed to delete vehicle record.");
            }
        };

        resultsDiv.innerHTML = "";
        vehicles.forEach((data) => {
            resultsDiv.innerHTML += `
                <div style="background:#f4ece0; padding:10px; margin-top:5px; border-radius:8px; font-family: sans-serif; font-size: 0.95rem;">
                    <b>Vehicle:</b> ${data.vehicleNumber}<br>
                    <b>Vehicle Type:</b> ${data.vehicleType}<br>
                    <b>Flat/Name:</b> ${data.flatNumber}<br>
                    <b>Resident Type:</b> ${data.residentType || 'N/A'}<br>
                    <b>Call:</b> <a href="tel:${data.mobileNumber}" style="color: #0066cc; text-decoration: none;">${data.mobileNumber}</a><br><br>
                    <button onclick="window.deleteVehicleDoc('${data.id}')" style="background:#d32f2f; color: white; border: none; border-radius: 4px; font-size:0.9rem; padding:5px 10px; cursor: pointer;">Delete</button>
                </div>
            `;
        });
    } catch (err) {
        window.showModal("Error searching vehicle data.");
    }
});

document.getElementById('saveBtn')?.addEventListener('click', async () => {
    const vNum = document.getElementById('vNum').value.trim().toUpperCase();
    const fNum = document.getElementById('fNum').value.trim();
    const rType = document.getElementById('rType').value;
    const mNum = document.getElementById('mNum').value.trim();
    const vType = document.getElementById('vType').value;

    if (!vNum || !fNum) return window.showModal("Vehicle number and Flat number/Name are required.");

    try {
        const res = await authenticatedFetch(`${API_BASE_URL}/vehicles?societyName=${encodeURIComponent(assignedSociety)}&vehicleNumber=${encodeURIComponent(vNum)}`);
        const vehicles = await res.json();

        const existingId = vehicles.length > 0 ? vehicles[0].id : null;

        await authenticatedFetch(`${API_BASE_URL}/vehicles`, {
            method: 'POST',
            body: JSON.stringify({
                id: existingId,
                vehicleNumber: vNum,
                flatNumber: fNum,
                residentType: rType,
                mobileNumber: mNum,
                vehicleType: vType,
                societyName: assignedSociety
            })
        });

        if (existingId) {
            window.showModal("Vehicle details updated successfully!");
        } else {
            window.showModal("Vehicle saved to registry successfully!");
        }

        document.getElementById('vNum').value = "";
        document.getElementById('fNum').value = "";
        document.getElementById('rType').value = "";
        document.getElementById('mNum').value = "";
    } catch (err) {
        window.showModal("Failed to save vehicle.");
        console.error(err);
    }
});

function buildTimeDropdownHTML(idPrefix) {
    let hourOptions = '<option value="">HH</option>';
    for (let i = 1; i <= 12; i++) {
        let hStr = i < 10 ? '0' + i : i;
        hourOptions += `<option value="${hStr}">${hStr}</option>`;
    }

    let minOptions = '<option value="00">00</option><option value="15">15</option><option value="30">30</option><option value="45">45</option>';

    return `
        <div style="display: flex; gap: 5px; align-items: center; display: inline-flex;">
            <select id="${idPrefix}Hour" style="padding: 6px; border-radius: 6px; border: 1px solid #d7ccc8; background: #fff;">${hourOptions}</select>
            <span>:</span>
            <select id="${idPrefix}Min" style="padding: 6px; border-radius: 6px; border: 1px solid #d7ccc8; background: #fff;">${minOptions}</select>
            <select id="${idPrefix}AmPm" style="padding: 6px; border-radius: 6px; border: 1px solid #d7ccc8; background: #fff;">
                <option value="AM">AM</option>
                <option value="PM">PM</option>
            </select>
        </div>
    `;
}

function getSelectedTimeString(idPrefix) {
    const hh = document.getElementById(`${idPrefix}Hour`).value;
    const mm = document.getElementById(`${idPrefix}Min`).value;
    const ap = document.getElementById(`${idPrefix}AmPm`).value;

    if (!hh) return null;

    let hour24 = parseInt(hh, 10);
    if (ap === "PM" && hour24 < 12) hour24 += 12;
    if (ap === "AM" && hour24 === 12) hour24 = 0;

    const formattedHour24 = hour24 < 10 ? '0' + hour24 : hour24;
    return `${formattedHour24}:${mm}`;
}

document.getElementById('downloadTemplateBtn')?.addEventListener('click', () => {
    const csvContent = "VehicleNumber,FlatNumber/Name,ResidentType,MobileNumber,VehicleType\nKA01AB1234,101,Owner,9876543210,2W\n";
    window.downloadCSV(csvContent, "vehicle_template.csv");
});

document.addEventListener('DOMContentLoaded', () => {

    async function loadSocietyLimits() {
        if (!assignedSociety) return;
        try {
            const res = await authenticatedFetch(`${API_BASE_URL}/societies/${assignedSociety}`);
            if (res.ok) {
                const data = await res.json();
                if (document.getElementById('max4WheelerInput')) {
                    document.getElementById('max4WheelerInput').value = data.max4Wheeler !== undefined ? data.max4Wheeler : 1;
                }
                if (document.getElementById('max2WheelerInput')) {
                    document.getElementById('max2WheelerInput').value = data.max2Wheeler !== undefined ? data.max2Wheeler : 2;
                }
            }
        } catch (err) {
            console.error("Failed to load society limits:", err);
        }
    }

    document.getElementById('saveSocietyLimitsBtn')?.addEventListener('click', async () => {
        const max4W = parseInt(document.getElementById('max4WheelerInput').value, 10);
        const max2W = parseInt(document.getElementById('max2WheelerInput').value, 10);

        if (isNaN(max4W) || isNaN(max2W)) {
            return window.showModal("Please enter valid numbers for vehicle limits.");
        }

        try {
            await authenticatedFetch(`${API_BASE_URL}/societies/${assignedSociety}/limits`, {
                method: 'PATCH',
                body: JSON.stringify({ max4Wheeler: max4W, max2Wheeler: max2W })
            });

            window.showModal("Society vehicle allowance limits updated successfully!");
        } catch (err) {
            console.error("Error saving limits:", err);
            window.showModal("Failed to save limits.");
        }
    });

    async function loadFlatNumbers() {
        if (!assignedSociety) return;
        try {
            const res = await authenticatedFetch(`${API_BASE_URL}/societies/${assignedSociety}`);
            if (res.ok) {
                const data = await res.json();
                if (data.flatList) {
                    const textarea = document.getElementById('flatsInput');
                    if (textarea) {
                        textarea.value = data.flatList.join(', ');
                    }
                }
            }
        } catch (err) {
            console.error("Failed to load flat numbers:", err);
        }
    }

    document.getElementById('saveFlatsBtn')?.addEventListener('click', async () => {
        const rawText = document.getElementById('flatsInput').value;
        const flatList = rawText.split(',').map(f => f.trim()).filter(f => f.length > 0);

        try {
            await authenticatedFetch(`${API_BASE_URL}/societies/${assignedSociety}/flats`, {
                method: 'PATCH',
                body: JSON.stringify({ flatList })
            });

            window.showModal("Flat numbers updated successfully!");
        } catch (err) {
            console.error("Error saving flat numbers:", err);
            window.showModal("Failed to save flat numbers.");
        }
    });

    document.getElementById('masterSaveSocietyBtn')?.addEventListener('click', async () => {
        const newSociety = document.getElementById('masterSocietyInput').value.trim();
        if (!newSociety) return window.showModal("Please enter a valid society name.");
        
        try {
            const res = await authenticatedFetch(`${API_BASE_URL}/admins/verify-society?society=${encodeURIComponent(newSociety)}`);
            const data = await res.json();

            if (!data.exists) {
                return window.showModal(`Society "${newSociety}" does not exist in the system.`);
            }

            assignedSociety = newSociety;
            window.showModal(`Active society switched to: ${assignedSociety}`);
            
            if (typeof loadNoticeData === 'function') loadNoticeData();
            if (typeof loadFacilitiesDropdown === 'function') loadFacilitiesDropdown();
            if (typeof loadActiveBookings === 'function') loadActiveBookings();

            let resultsContainer = document.getElementById('master-society-data');
            if (!resultsContainer) {
                resultsContainer = document.createElement('div');
                resultsContainer.id = 'master-society-data';
                resultsContainer.style.cssText = "margin-top: 15px; text-align: left; font-size: 0.9rem; background: #fff; padding: 10px; border-radius: 6px; border: 1px solid #d32f2f;";
                document.getElementById('master-admin-panel').appendChild(resultsContainer);
            }

            resultsContainer.innerHTML = `<b>Linked Data for ${assignedSociety}:</b><br>Found admin profile(s) linked to this society.`;

        } catch (err) {
            console.error("Error verifying society existence:", err);
            window.showModal("Failed to verify society name.");
        }
    });

    async function loadNoticeData() {
        if (!assignedSociety) return;
        
        const options = { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' };
        const formatter = new Intl.DateTimeFormat('en-CA', options);
        const currentIstDateStr = formatter.format(new Date());

        try {
            const res = await authenticatedFetch(`${API_BASE_URL}/notices/${assignedSociety}`);
            if (res.ok) {
                const data = await res.json();
                let todayMsg = data.todayMessage || "";
                let tomorrowMsg = data.tomorrowMessage || "";
                let noticeDate = data.date || "";

                if (noticeDate && noticeDate < currentIstDateStr) {
                    todayMsg = tomorrowMsg;
                    tomorrowMsg = "";
                    noticeDate = currentIstDateStr;

                    await authenticatedFetch(`${API_BASE_URL}/notices/${assignedSociety}`, {
                        method: 'POST',
                        body: JSON.stringify({ todayMessage: todayMsg, tomorrowMessage: tomorrowMsg, date: noticeDate })
                    });
                }

                if (document.getElementById('todayMsg')) document.getElementById('todayMsg').value = todayMsg;
                if (document.getElementById('tomorrowMsg')) document.getElementById('tomorrowMsg').value = tomorrowMsg;
            }
        } catch (err) {
            console.error("Failed loading notice data:", err);
        }
    }

    document.getElementById('masterSavePhoneBtn')?.addEventListener('click', async () => {
        const newPhone = document.getElementById('masterPhoneInput').value.trim();
        if (!newPhone) return window.showModal("Please enter a valid phone number.");
        
        try {
            await authenticatedFetch(`${API_BASE_URL}/config`, {
                method: 'POST',
                body: JSON.stringify({ teamPhone: newPhone })
            });

            teamPhone = newPhone;
            window.showModal(`Team WhatsApp phone updated and saved to database: ${teamPhone}`);
        } catch (err) {
            console.error("Error saving team phone:", err);
            window.showModal("Failed to save phone number.");
        }
    });

    document.getElementById('saveAllFacilityNamesBtn')?.addEventListener('click', saveAllFacilityNames);

    const timeContainer = document.getElementById('bookingTimeContainer');
    if (timeContainer) {
        timeContainer.innerHTML = `
            <div style="margin-bottom: 10px;">
                <label style="display: block; font-size: 0.9rem; margin-bottom: 3px;">Start Time:</label>
                ${buildTimeDropdownHTML('start')}
            </div>
            <div>
                <label style="display: block; font-size: 0.9rem; margin-bottom: 3px;">End Time:</label>
                ${buildTimeDropdownHTML('end')}
            </div>
        `;
    }

    onAuthStateChanged(auth, async (user) => {
        if (user) {
            try {
                // Ensure Firebase auth session exists before running authenticated requests
                const token = await user.getIdToken(true);
                if (!token) {
                    console.warn("User authenticated, but failed to retrieve a valid ID token.");
                    return;
                }

                const res = await authenticatedFetch(`${API_BASE_URL}/admins?email=${encodeURIComponent(user.email)}`);
                if (res.ok) {
                    const adminData = await res.json();
                    assignedSociety = adminData.society || "";
                    isMasterAdminUser = adminData.isMaster || false;

                    document.getElementById('login-section').style.display = 'none';
                    document.getElementById('search-section').style.display = 'block';
                    document.getElementById('data-section').style.display = 'block';

                    if (isMasterAdminUser) {
                        localStorage.setItem("isAdminMaster", "true");
                        const bulkSection = document.getElementById('bulk-section');
                        if (bulkSection) bulkSection.style.display = 'block';

                        const masterPanel = document.getElementById('master-admin-panel');
                        if (masterPanel) {
                            masterPanel.style.display = 'block';
                            document.getElementById('masterSocietyInput').value = assignedSociety;
                            document.getElementById('masterPhoneInput').value = teamPhone;
                        }

                        // Display the Spin Count Analytics Section specifically for MasterAdmin
                        const spinSection = document.getElementById('masterAdminSpinSection');
                        if (spinSection) spinSection.style.display = 'block';
                    }
                    
                    if (assignedSociety) {
                        loadNoticeData();
                        loadFacilitiesDropdown();
                        loadActiveBookings();
                    } else {
                        console.warn("Admin profile loaded, but no society assigned.");
                    }
                } else {
                    window.showModal("Unauthorized access.");
                    signOut(auth);
                }
            } catch (e) {
                window.showModal("Error verifying admin profile.");
            }
        } else {
            document.getElementById('login-section').style.display = 'block';
            document.getElementById('search-section').style.display = 'none';
            document.getElementById('data-section').style.display = 'none';
        }
    });

    document.getElementById('loginBtn')?.addEventListener('click', async () => {
        const emailInput = document.getElementById('email');
        const passInput = document.getElementById('pass');

        if (!emailInput || !passInput) return;

        const email = emailInput.value.trim().toLowerCase();
        const pass = passInput.value.trim();

        if (!email || !pass) {
            window.showModal("Pls enter email id and password");
            return;
        }

        try {
            await signInWithEmailAndPassword(auth, email, pass);

            localStorage.setItem("adminLoggedIn", "true");
            window.showModal("Login successful");
        } catch (e) {
            console.error("Full Login Error:", e);
            let userMsg = "Login error: " + (e.message || e);
            if (e.code === 'auth/invalid-credential' || e.code === 'auth/wrong-password' || e.code === 'auth/user-not-found' || e.code === 'auth/invalid-email') {
                userMsg = "Wrong email or password entered.";
            }
            window.showModal(userMsg);
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
            const res = await authenticatedFetch(`${API_BASE_URL}/admins?email=${encodeURIComponent(email)}`);
            const adminData = await res.json();

            let exists = res.ok && adminData;
            if (Array.isArray(adminData)) {
                exists = exists && adminData.length > 0;
            } else if (adminData && typeof adminData === 'object') {
                exists = exists && (adminData.society || adminData.email || adminData.id);
            } else {
                exists = false;
            }

            if (!exists) {
                window.showModal("No admin registered with this entered email id");
                return;
            }

            await sendPasswordResetEmail(auth, email);
            window.showModal("Password reset link sent to your email!");
        } catch (error) {
            console.error("Error sending password reset email:", error);
            window.showModal("No admin registered with this entered email id");
        }
    });

    document.getElementById('logoutBtn')?.addEventListener('click', () => signOut(auth));

    document.getElementById('postNoticeBtn')?.addEventListener('click', async () => {
        await authenticatedFetch(`${API_BASE_URL}/notices/${assignedSociety}`, {
            method: 'POST',
            body: JSON.stringify({
                todayMessage: document.getElementById('todayMsg').value,
                tomorrowMessage: document.getElementById('tomorrowMsg').value,
                date: new Date().toLocaleDateString('en-CA')
            })
        });
        window.showModal("Notices updated successfully!");
    });

    document.getElementById('deleteNoticeBtn')?.addEventListener('click', async () => {
        await authenticatedFetch(`${API_BASE_URL}/notices/${assignedSociety}`, { method: 'DELETE' });
        document.getElementById('todayMsg').value = "";
        document.getElementById('tomorrowMsg').value = "";
        window.showModal("Notice deleted.");
    });

    window.updateFacilityName = async (fId) => {
        const newName = document.getElementById(`name_${fId}`).value.trim();
        if (!newName) return window.showModal("Please enter a name.");
        
        await authenticatedFetch(`${API_BASE_URL}/facilities/${assignedSociety}`, {
            method: 'POST',
            body: JSON.stringify({ [fId]: newName })
        });
        window.showModal(`${fId} updated to ${newName}`);
        loadFacilitiesDropdown(); 
    }; 

    async function saveAllFacilityNames() {
        const data = {
            F1: document.getElementById('name_F1').value,
            F2: document.getElementById('name_F2').value,
            F3: document.getElementById('name_F3').value,
            F4: document.getElementById('name_F4').value,
            F5: document.getElementById('name_F5').value
        };
        
        await authenticatedFetch(`${API_BASE_URL}/facilities/${assignedSociety}`, {
            method: 'POST',
            body: JSON.stringify(data)
        });
        window.showModal("Facility names updated!");
        loadFacilitiesDropdown(); 
    }

    async function loadFacilitiesDropdown() {
        if (!assignedSociety) return;
        const res = await authenticatedFetch(`${API_BASE_URL}/facilities/${assignedSociety}`);
        const data = res.ok ? await res.json() : {};
        const select = document.getElementById('facilitySelect');
        
        select.innerHTML = "";
        ['F1', 'F2', 'F3', 'F4', 'F5'].forEach(fId => {
            const displayName = data[fId] || `Not Assigned (${fId})`;
            select.innerHTML += `<option value="${fId}">${fId}: ${displayName}</option>`;
            
            const input = document.getElementById(`name_${fId}`);
            if (input) input.value = data[fId] || "";
        });
    }

    async function loadActiveBookings() {
        if (!assignedSociety) return;
        const listContainer = document.getElementById('active-bookings-list');
        if (!listContainer) return;

        listContainer.innerHTML = "<p style='font-size: 0.9rem;'>Loading bookings...</p>";

        try {
            const fRes = await authenticatedFetch(`${API_BASE_URL}/facilities/${assignedSociety}`);
            const facilityNames = fRes.ok ? await fRes.json() : {};

            const bRes = await authenticatedFetch(`${API_BASE_URL}/bookings?society=${encodeURIComponent(assignedSociety)}`);
            const bookings = bRes.ok ? await bRes.json() : [];

            if (bookings.length === 0) {
                listContainer.innerHTML = "<p style='font-size: 0.9rem; color: #777;'>No active bookings found.</p>";
                return;
            }

            listContainer.innerHTML = "<h4>Active Bookings:</h4>";
            bookings.forEach((data) => {
                const facilityName = facilityNames[data.facilityId] || data.facilityId;
                
                const startTimeFormatted = data.start ? data.start.replace('T', ' ') : '';
                const endTimeFormatted = data.end ? data.end.split('T')[1] : '';

                listContainer.innerHTML += `
                    <div style="background:#f4ece0; padding:10px; margin-top:8px; border-radius:8px; font-size: 0.95rem; display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <b>${facilityName}</b><br>
                            <span style="font-size: 0.85rem; color: #555;">${startTimeFormatted} to ${endTimeFormatted}</span>
                        </div>
                        <button onclick="window.deleteBooking('${data.id}')" style="background:#d32f2f; font-size:0.8rem; padding:5px 10px; margin:0;">Delete</button>
                    </div>
                `;
            });
        } catch (err) {
            listContainer.innerHTML = "<p style='font-size: 0.9rem; color: red;'>Error loading bookings.</p>";
            console.error(err);
        }
    }
        
    document.getElementById('bookFacilityBtn')?.addEventListener('click', async () => {
        const fId = document.getElementById('facilitySelect').value;
        const dateInput = document.getElementById('bookingDate');
        const date = dateInput.value; 
        
        const startT = getSelectedTimeString('start'); 
        const endT = getSelectedTimeString('end');     

        if (!date || !startT || !endT) return window.showModal("Please select a date and valid start/end times.");

        const todayStr = new Date().toISOString().split('T')[0];
        const maxDate = new Date();
        maxDate.setMonth(maxDate.getMonth() + 6);
        const maxDateStr = maxDate.toISOString().split('T')[0];

        if (date < todayStr || date > maxDateStr) {
            return window.showModal("Bookings are only allowed from today up to 6 months in advance.");
        }

        try {
            await authenticatedFetch(`${API_BASE_URL}/bookings`, {
                method: 'POST',
                body: JSON.stringify({
                    society: assignedSociety, 
                    facilityId: fId, 
                    start: `${date}T${startT}:00`, 
                    end: `${date}T${endT}:00`
                })
            });
            window.showModal("Booking created successfully!");
            loadActiveBookings(); 
        } catch (err) {
            window.showModal("Failed to create booking.");
        }
    });

    window.deleteBooking = async (bookingDocId) => {
        try {
            await authenticatedFetch(`${API_BASE_URL}/bookings/${bookingDocId}`, { method: 'DELETE' });
            window.showModal("Booking deleted.");
            loadActiveBookings(); 
        } catch (err) {
            window.showModal("Failed to delete booking.");
        }
    };

    document.getElementById('importBtn')?.addEventListener('click', () => {
        const file = document.getElementById('excelInput').files[0];
        if (!file) return window.showModal("Select CSV.");

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const rows = e.target.result.split('\n').slice(1);
                let addedCount = 0;
                let skippedCount = 0;

                for (const row of rows) {
                    const c = row.split(',');
                    if (c.length >= 2 && c[0].trim()) {
                        const vNum = c[0].trim().toUpperCase();
                        const fNum = c[1].trim();
                        const rType = c[2] ? c[2].trim() : "Owner";
                        const mNum = c[3] ? c[3].trim() : "";
                        const vType = c[4] ? c[4].trim() : "2-Wheeler";

                        const checkRes = await authenticatedFetch(`${API_BASE_URL}/vehicles?societyName=${encodeURIComponent(assignedSociety)}&vehicleNumber=${encodeURIComponent(vNum)}`);
                        const existing = await checkRes.json();

                        if (existing.length === 0) {
                            await authenticatedFetch(`${API_BASE_URL}/vehicles`, {
                                method: 'POST',
                                body: JSON.stringify({
                                    vehicleNumber: vNum,
                                    flatNumber: fNum,
                                    residentType: rType,
                                    mobileNumber: mNum,
                                    vehicleType: vType,
                                    societyName: assignedSociety
                                })
                            });
                            addedCount++;
                        } else {
                            skippedCount++;
                        }
                    }
                }

                window.showModal(`Import complete! Added: ${addedCount}, Omitted (already exists): ${skippedCount}`);
            } catch (err) {
                console.error("Bulk Import Error:", err);
                window.showModal("Import failed: " + (err.message || err));
            }
        };
        reader.readAsText(file);
    });

    document.getElementById('approveAdBtn')?.addEventListener('click', async () => {
        const adKey = document.getElementById('adApprovalKey').value.trim().toUpperCase();
        await authenticatedFetch(`${API_BASE_URL}/ads/${adKey}`, {
            method: 'PATCH',
            body: JSON.stringify({ societyApproved: true })
        });
        window.showModal("Ad Approved!");
        window.open(`https://wa.me/${teamPhone}?text=Admin of ${assignedSociety} approved Ad: ${adKey}`);
    });

    document.getElementById('exportBtn')?.addEventListener('click', async () => {
        if (!assignedSociety) return;
        try {
            const res = await authenticatedFetch(`${API_BASE_URL}/vehicles?societyName=${encodeURIComponent(assignedSociety)}`);
            const vehicles = await res.json();
            if (vehicles.length === 0) return window.showModal("No data to export.");

            let csv = "VehicleNumber,FlatNumber/Name,ResidentType,MobileNumber,VehicleType\n";
            vehicles.forEach(data => {
                csv += `${data.vehicleNumber},${data.flatNumber},${data.residentType || 'Owner'},${data.mobileNumber},${data.vehicleType}\n`;
            });

            window.downloadCSV(csv, `${assignedSociety}_vehicles.csv`);
        } catch (err) {
            window.showModal("Export failed.");
        }
    });

    document.getElementById('bulkDeleteBtn')?.addEventListener('click', () => {
        const file = document.getElementById('excelInput').files[0];
        if (!file) return window.showModal("Please select a CSV file containing vehicles to delete.");

        window.showModal("Are you sure you want to delete the vehicles listed in the uploaded CSV? This cannot be undone.", true);
        window.confirmDelete = async () => {
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const rows = e.target.result.split('\n').slice(1);
                    let deleteCount = 0;
                    let notFoundCount = 0;

                    for (const row of rows) {
                        const c = row.split(',');
                        if (c.length >= 1 && c[0].trim()) {
                            const vNum = c[0].trim().toUpperCase();
                            const res = await authenticatedFetch(`${API_BASE_URL}/vehicles?societyName=${encodeURIComponent(assignedSociety)}&vehicleNumber=${encodeURIComponent(vNum)}`);
                            const vehicles = await res.json();

                            if (vehicles.length > 0) {
                                for (const v of vehicles) {
                                    await authenticatedFetch(`${API_BASE_URL}/vehicles/${v.id}`, { method: 'DELETE' });
                                    deleteCount++;
                                }
                            } else {
                                notFoundCount++;
                            }
                        }
                    }

                    window.showModal(`Targeted Bulk Delete complete! Deleted: ${deleteCount}, Not Found: ${notFoundCount}`);
                    window.closeModal();
                    if (document.getElementById('admin-results')) document.getElementById('admin-results').innerHTML = "";
                } catch (err) {
                    console.error("Bulk Delete Error:", err);
                    window.showModal("Bulk delete failed: " + (err.message || err));
                }
            };
            reader.readAsText(file);
        };
    });
});