import { auth, authenticatedFetch } from "./app.js";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { Filesystem, Directory, Encoding } from 'https://cdn.jsdelivr.net/npm/@capacitor/filesystem@latest/+esm';
import { Share } from 'https://cdn.jsdelivr.net/npm/@capacitor/share@latest/+esm';

const API_BASE_URL = (window.OWL_API_BASE || 'https://us-central1-finder-owl.cloudfunctions.net/api');
const NG_HEADERS = { 'ngrok-skip-browser-warning': 'true' };

let assignedSociety = "";
let teamPhone = "919033406816";
let isMasterAdminUser = false;

// --- UI & Global Helpers ---
window.showModal = (msg, showConfirm = false) => {
    // textContent (not innerText) so the message is real text everywhere,
    // including when the dialog is measured by non-browser renderers.
    document.getElementById('modalMessage').textContent = msg;
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
        const res = await authenticatedFetch(`${window.OWL_API_BASE || 'https://us-central1-finder-owl.cloudfunctions.net/api'}/contest/spinstats?societyName=${encodeURIComponent(societyName)}`);
        
        if (res.ok) {
            const data = await res.json();
            
            const lifetime = data.totalLifetimeSpins !== undefined ? data.totalLifetimeSpins : (data.totalSpins || 0);
            const daily = data.totalDaySpins || 0;
            const monthly = data.totalMonthSpins || 0;
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
function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function digitsOnly(value) {
    return String(value == null ? '' : value).replace(/\D/g, '');
}

// Loads a registry record into the add/edit form so the admin can change it.
window.editVehicle = (docId) => {
    const record = registryCache.get(docId);
    if (!record) return window.showModal("That record is no longer loaded. Search again.");
    document.getElementById('vNum').value = record.vehicleNumber || '';
    const flatField = document.getElementById('fNum');
    flatField.value = record.flatNumber || '';
    if (flatField.value && !societyFlats.includes(flatField.value)) {
        // Keep a stored flat selectable so an edit never silently changes it.
        renderFlatOptions([...societyFlats, flatField.value]);
    }
    document.getElementById('rType').value = record.residentType || '';
    document.getElementById('vType').value = record.vehicleType || '2-Wheeler';
    document.getElementById('mNum').value = digitsOnly(record.mobileNumber).slice(-10);
    const form = document.getElementById('vNum');
    if (form && typeof form.scrollIntoView === 'function') form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('fNum')?.focus();
    window.showModal(`Editing ${record.vehicleNumber}. Change the details and press "Save changes".`);
};

window.deleteVehicleDoc = async (docId) => {
    const record = registryCache.get(docId);
    const label = record ? record.vehicleNumber : 'this vehicle';
    if (!window.confirm(`Delete ${label} from the society registry? This cannot be undone.`)) return;
    try {
        const res = await authenticatedFetch(`${API_BASE_URL}/vehicles/${encodeURIComponent(docId)}`, { method: 'DELETE' });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `Delete failed (${res.status})`);
        }
        registryCache.delete(docId);
        renderVehicleResults([...registryCache.values()], `Updated: ${label} was deleted.`);
    } catch (err) {
        window.showModal("Failed to delete vehicle record: " + (err.message || err));
    }
};

// `registryCache` keeps the last search results so Edit can fill the form.
const registryCache = new Map();

function renderVehicleResults(vehicles, emptyMessage) {
    const resultsDiv = document.getElementById('admin-results');
    if (!resultsDiv) return;
    if (!vehicles.length) {
        resultsDiv.innerHTML = `<p>${escapeHtml(emptyMessage || 'No vehicle found in this society.')}</p>`;
        return;
    }
    resultsDiv.innerHTML = vehicles.map((data) => {
        const mobile = digitsOnly(data.mobileNumber);
        const call = mobile
            ? `<a href="tel:${escapeHtml(mobile)}" style="color:#0066cc;text-decoration:none;">${escapeHtml(mobile)}</a>`
            : 'N/A';
        const deviceNote = data.deviceId
            ? '<div style="color:#8a6d3b;">Device-linked: the flat cannot be changed here.</div>'
            : '';
        return `
            <div class="vehicle-result" data-vehicle-id="${escapeHtml(data.id)}" style="background:#f4ece0; padding:10px; margin-top:8px; border-radius:8px; font-family: sans-serif; font-size: 0.95rem;">
                <b>Vehicle:</b> ${escapeHtml(data.vehicleNumber)}<br>
                <b>Vehicle Type:</b> ${escapeHtml(data.vehicleType || 'N/A')}<br>
                <b>Flat/Name:</b> ${escapeHtml(data.flatNumber || 'N/A')}<br>
                <b>Resident Type:</b> ${escapeHtml(data.residentType || 'N/A')}<br>
                <b>Mobile:</b> ${call}
                ${deviceNote}
                <div style="margin-top:8px; display:flex; gap:8px;">
                    <button type="button" data-action="edit" data-id="${escapeHtml(data.id)}" style="background:#6d4c33; color:#fff; border:none; border-radius:4px; font-size:0.9rem; padding:5px 12px; cursor:pointer;">Edit</button>
                    <button type="button" data-action="delete" data-id="${escapeHtml(data.id)}" style="background:#d32f2f; color:white; border: none; border-radius: 4px; font-size:0.9rem; padding:5px 10px; cursor: pointer;">Delete</button>
                </div>
            </div>
        `;
    }).join('');

    resultsDiv.querySelectorAll('button[data-action]').forEach(button => {
        button.addEventListener('click', () => {
            const id = button.dataset.id;
            if (button.dataset.action === 'edit') window.editVehicle(id);
            else window.deleteVehicleDoc(id);
        });
    });
}

document.getElementById('adminSearchBtn')?.addEventListener('click', async () => {
    const searchVal = document.getElementById('adminSearch').value.trim().toUpperCase();
    const resultsDiv = document.getElementById('admin-results');
    if (!searchVal) return window.showModal("Please enter a vehicle number to search.");
    if (!assignedSociety) return window.showModal("Your admin account is not assigned to a society yet.");
    resultsDiv.innerHTML = "Searching...";
    registryCache.clear();
    try {
        const res = await authenticatedFetch(`${API_BASE_URL}/vehicles?societyName=${encodeURIComponent(assignedSociety)}&vehicleNumber=${encodeURIComponent(searchVal)}`);
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `Search failed (${res.status})`);
        }
        const vehicles = await res.json();
        (Array.isArray(vehicles) ? vehicles : []).forEach(vehicle => registryCache.set(vehicle.id, vehicle));
        renderVehicleResults([...registryCache.values()], `No vehicle ${searchVal} is registered in ${assignedSociety}.`);
    } catch (err) {
        resultsDiv.innerHTML = "";
        window.showModal("Error searching vehicle data: " + (err.message || err));
    }
});

document.getElementById('adminSearch')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        document.getElementById('adminSearchBtn')?.click();
    }
});

// Add / edit vehicle. The plate decides: if that number already exists in the
// assigned society the existing Firestore document is updated, otherwise a new
// one is created. The record id is never taken from the form, so an admin can
// never overwrite a vehicle in another society by pasting an id.
document.getElementById('saveBtn')?.addEventListener('click', async () => {
    const vNum = document.getElementById('vNum').value.trim().toUpperCase().replace(/\s+/g, ' ');
    let fNum = document.getElementById('fNum').value.trim();
    const rType = document.getElementById('rType').value;
    const mNum = digitsOnly(document.getElementById('mNum').value).slice(-10);
    const vType = document.getElementById('vType').value;

    if (!assignedSociety) return window.showModal("Your admin account is not assigned to a society yet.");
    if (!vNum || !fNum) return window.showModal("Vehicle number and Flat number/Name are required.");
    if (!/^[A-Z0-9 -]{1,20}$/.test(vNum)) return window.showModal("Vehicle number may contain only letters, digits, spaces and hyphens.");
    if (mNum && mNum.length !== 10) return window.showModal("Mobile number must be 10 digits (or left blank).");
    // The flat must be one the society has registered; the dropdown lists them,
    // and this catches a typed value that does not match any of them. The stored
    // casing wins, so "b2-201" is saved as the society's "B2-201".
    if (societyFlats.length) {
        const normalise = value => String(value || '').trim().toUpperCase().replace(/\s+/g, '');
        const match = societyFlats.find(flat => normalise(flat) === normalise(fNum));
        if (!match) {
            return window.showModal(`${fNum} is not a registered flat in ${assignedSociety}. Pick a flat from the list.`);
        }
        fNum = match;
        document.getElementById('fNum').value = match;
    }

    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn) saveBtn.disabled = true;
    try {
        // Is this plate already in this society's registry?
        const lookup = await authenticatedFetch(`${API_BASE_URL}/vehicles?societyName=${encodeURIComponent(assignedSociety)}&vehicleNumber=${encodeURIComponent(vNum)}`);
        if (!lookup.ok) {
            const body = await lookup.json().catch(() => ({}));
            throw new Error(body.error || `Lookup failed (${lookup.status})`);
        }
        const found = await lookup.json();
        const existing = (Array.isArray(found) ? found : []).find(vehicle =>
            String(vehicle.vehicleNumber || '').trim().toUpperCase() === vNum) || null;

        const res = await authenticatedFetch(`${API_BASE_URL}/vehicles`, {
            method: 'POST',
            body: JSON.stringify({
                id: existing ? existing.id : null,
                vehicleNumber: vNum,
                flatNumber: fNum,
                residentType: rType || 'Resident',
                mobileNumber: mNum,
                vehicleType: vType,
                societyName: assignedSociety
            })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (body.code === 'vehicle-limit-reached') {
                // The API message already names the allowance and where to raise it.
                const limitError = new Error(body.error);
                limitError.isAllowance = true;
                throw limitError;
            }
            throw new Error(body.error || `Save failed (${res.status})`);
        }

        window.showModal(existing
            ? `${vNum} already existed in ${assignedSociety}, so its record was updated.`
            : `${vNum} was added to the ${assignedSociety} registry.`);

        // Keep the search results in step with the save.
        if (existing) {
            registryCache.set(existing.id, { ...existing, vehicleNumber: vNum, flatNumber: fNum, residentType: rType || 'Resident', mobileNumber: mNum, vehicleType: vType });
        } else {
            registryCache.clear();
        }

        document.getElementById('vNum').value = "";
        document.getElementById('fNum').value = "";
        document.getElementById('rType').value = "";
        document.getElementById('mNum').value = "";
        if (existing) renderVehicleResults([...registryCache.values()]);
        loadSocietyFlats();
    } catch (err) {
        const message = String(err.message || err);
        window.showModal(err.isAllowance ? message : "Failed to save vehicle: " + message);
        console.error(err);
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
});

// The time pickers inherit theme.css, so they must use theme variables. A
// hardcoded white background with the page's light text (dark mode) made the
// selected time invisible against the card.
function buildTimeDropdownHTML(idPrefix) {
    let hourOptions = '<option value="">HH</option>';
    for (let i = 1; i <= 12; i++) {
        let hStr = i < 10 ? '0' + i : i;
        hourOptions += `<option value="${hStr}">${hStr}</option>`;
    }

    let minOptions = '<option value="00">00</option><option value="15">15</option><option value="30">30</option><option value="45">45</option>';

    return `
        <div class="time-picker">
            <select id="${idPrefix}Hour" aria-label="${idPrefix === 'end' ? 'End' : 'Start'} hour">${hourOptions}</select>
            <span class="time-sep" aria-hidden="true">:</span>
            <select id="${idPrefix}Min" aria-label="${idPrefix === 'end' ? 'End' : 'Start'} minutes">${minOptions}</select>
            <select id="${idPrefix}AmPm" aria-label="${idPrefix === 'end' ? 'End' : 'Start'} AM or PM">
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

    if (!/^[0-5]\d$/.test(mm || '')) return null;
    let hour24 = parseInt(hh, 10);
    if (!Number.isInteger(hour24) || hour24 < 1 || hour24 > 12) return null;
    if (ap === "PM" && hour24 < 12) hour24 += 12;
    if (ap === "AM" && hour24 === 12) hour24 = 0;

    const formattedHour24 = hour24 < 10 ? '0' + hour24 : hour24;
    return `${formattedHour24}:${mm}`;
}

document.getElementById('downloadTemplateBtn')?.addEventListener('click', () => {
    const csvContent = "VehicleNumber,FlatNumber/Name,ResidentType,MobileNumber,VehicleType\n" +
        "GJ01AB1234,A1-101,Owner,9876543210,2-Wheeler\n" +
        "GJ01CD5678,A1-101,Tenant,9812345678,4-Wheeler\n";
    window.downloadCSV(csvContent, "vehicle_template.csv");
});

// Bookings older than 7 days are removed automatically (server maintenance
// job). The list mirrors that rule so an expired booking never appears as
// "active" while waiting for the nightly clean-up.
const BOOKING_RETENTION_DAYS = 7;

function escapeText(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatBookingTime(iso) {
    const datePart = String(iso || '').split('T')[1];
    if (!datePart) return '';
    const [hour, minute] = datePart.split(':');
    const h = parseInt(hour, 10);
    if (Number.isNaN(h)) return '';
    const suffix = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${minute} ${suffix}`;
}

function isExpiredBooking(booking, now = new Date()) {
    const end = new Date(booking && booking.end ? booking.end : booking && booking.start);
    if (Number.isNaN(end.getTime())) return false;
    const cutoff = new Date(now.getTime() - BOOKING_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    return end < cutoff;
}

// Sorted soonest first and grouped by date, so the admin reads the schedule
// the way it happens.
function renderActiveBookings(bookings, facilityNames) {
    const listContainer = document.getElementById('active-bookings-list');
    if (!listContainer) return;
    const upcoming = (Array.isArray(bookings) ? bookings : [])
        .filter(booking => !isExpiredBooking(booking))
        .sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
    if (!upcoming.length) {
        listContainer.innerHTML = "<h4>Active bookings</h4><p class='small' style='color: var(--ow-muted);'>No active bookings found.</p>";
        return;
    }
    listContainer.innerHTML = `<h4>Active bookings (${upcoming.length})</h4>` + upcoming.map(booking => {
        const facilityName = facilityNames[booking.facilityId] || booking.facilityId || 'Facility';
        const date = String(booking.start || '').split('T')[0];
        const startTime = formatBookingTime(booking.start);
        const endTime = formatBookingTime(booking.end);
        return `
            <div class="booking-item" data-booking-id="${escapeText(booking.id)}" style="background: var(--ow-surface-2); padding:10px; margin-top:8px; border-radius:8px; border: 1px solid var(--ow-border); font-size: 0.95rem;">
                <div>
                    <div class="booking-facility"><b>${escapeText(facilityName)}</b></div>
                    <div class="booking-when">${escapeText(date)}${startTime ? ` · ${escapeText(startTime)}${endTime ? ' to ' + escapeText(endTime) : ''}` : ''}</div>
                </div>
                <button type="button" data-booking-delete="${escapeText(booking.id)}" class="btn-danger-soft btn-sm" style="background: var(--ow-danger); color: #fff; font-size:0.8rem; padding:6px 12px;">Delete</button>
            </div>
        `;
    }).join('');

    listContainer.querySelectorAll('[data-booking-delete]').forEach(button => {
        button.addEventListener('click', () => window.deleteBooking(button.dataset.bookingDelete));
    });
}

async function loadActiveBookings() {
    if (!assignedSociety) return;
    const listContainer = document.getElementById('active-bookings-list');
    if (!listContainer) return;

    listContainer.innerHTML = "<p class='small' style='color: var(--ow-muted);'>Loading bookings...</p>";

    try {
        const [fRes, bRes] = await Promise.all([
            authenticatedFetch(`${API_BASE_URL}/facilities/${encodeURIComponent(assignedSociety)}`),
            authenticatedFetch(`${API_BASE_URL}/bookings?society=${encodeURIComponent(assignedSociety)}`)
        ]);
        const facilityNames = fRes.ok ? await fRes.json() : {};
        const bookings = bRes.ok ? await bRes.json() : [];
        renderActiveBookings(bookings, facilityNames || {});
    } catch (err) {
        listContainer.innerHTML = "<p class='small' style='color: var(--ow-danger);'>Could not load bookings. Please refresh.</p>";
        console.error(err);
    }
}

// --- Bulk vehicle import ---------------------------------------------------
// A small RFC-4180-ish CSV reader: quoted fields, escaped quotes, CRLF or LF
// line endings, and an optional header row in any column order. The browser
// parses the file; the API validates and writes it per society.
function parseCsvText(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    const source = String(text || '').replace(/^\uFEFF/, '');
    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (quoted) {
            if (char === '"') {
                if (source[i + 1] === '"') { field += '"'; i++; }
                else quoted = false;
            } else field += char;
            continue;
        }
        if (char === '"') { quoted = true; continue; }
        if (char === ',') { row.push(field); field = ''; continue; }
        if (char === '\r') continue;
        if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
        field += char;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(cells => cells.some(cell => String(cell).trim() !== ''));
}

const IMPORT_COLUMNS = {
    vehicleNumber: ['vehiclenumber', 'vehicle no', 'vehicle_no', 'plate', 'platenumber', 'registrationnumber', 'vehicle'],
    flatNumber: ['flatnumber/name', 'flatnumber', 'flat no', 'flat_no', 'flat', 'flatname'],
    residentType: ['residenttype', 'resident', 'occupancy'],
    mobileNumber: ['mobilenumber', 'mobile', 'mobile no', 'phone', 'contact'],
    vehicleType: ['vehicletype', 'vehicle type', 'wheeler', 'category']
};

function columnKey(header) {
    const value = String(header == null ? '' : header).trim().toLowerCase().replace(/\s+/g, ' ');
    for (const [key, aliases] of Object.entries(IMPORT_COLUMNS)) {
        if (aliases.includes(value)) return key;
    }
    return null;
}

// Returns objects keyed by field name so the API never depends on column order.
function parseVehicleCsv(text) {
    const table = parseCsvText(text);
    if (!table.length) return [];
    const first = table[0].map(cell => String(cell).trim());
    const mapped = first.map(columnKey);
    const hasHeader = mapped.includes('vehicleNumber');
    const columns = hasHeader ? mapped : ['vehicleNumber', 'flatNumber', 'residentType', 'mobileNumber', 'vehicleType'];
    const dataRows = hasHeader ? table.slice(1) : table;
    return dataRows.map(cells => {
        const row = {};
        columns.forEach((key, index) => {
            if (!key) return;
            row[key] = cells[index] === undefined ? '' : String(cells[index]).trim();
        });
        return row;
    }).filter(row => Object.values(row).some(value => String(value).trim() !== ''));
}

function importHeadline(summary) {
    const party = `Added ${summary.added || 0}, updated ${summary.updated || 0}, duplicates skipped ${summary.repeat || 0}, rejected ${summary.rejected || 0}`;
    return `${summary.society ? summary.society + ': ' : ''}import complete. ${party} of ${summary.total || 0} row(s).`;
}

function renderImportReport(summary) {
    const report = document.getElementById('import-report');
    if (!report) return;
    const changes = Array.isArray(summary.changes) ? summary.changes : [];
    const errors = Array.isArray(summary.errors) ? summary.errors : [];
    const chip = (cls, text) => `<span class="import-chip ${cls}">${escapeText(text)}</span>`;
    const list = changes.slice(0, 200).map(change => {
        const verb = change.action === 'added' ? 'Added' : change.action === 'updated' ? 'Updated' : 'Skipped (duplicate)';
        return `<li><b>${escapeText(change.plate)}</b> — ${verb}${change.flat ? ` · flat ${escapeText(change.flat)}` : ''}${change.reason ? ` <span class="import-reason">(${escapeText(change.reason)})</span>` : ''}</li>`;
    }).join('');
    const errorList = errors.slice(0, 200).map(error =>
        `<li><b>${escapeText(error.plate || `line ${error.line}`)}</b> <span class="import-reason">— ${escapeText(error.reason)}</span></li>`).join('');
    report.innerHTML = `
        <div class="import-summary">
            ${chip('is-added', `Added ${summary.added || 0}`)}
            ${chip('is-updated', `Updated ${summary.updated || 0}`)}
            ${chip('is-repeat', `Duplicates skipped ${summary.repeat || 0}`)}
            ${chip('is-rejected', `Rejected ${summary.rejected || 0}`)}
            ${chip('', `Rows ${summary.total || 0}`)}
        </div>
        ${summary.truncated ? '<p class="small" style="color: var(--ow-danger);">Only the first 2000 rows were imported.</p>' : ''}
        ${changes.length ? `<h4>Per-vehicle result</h4><ul class="import-list">${list}</ul>` : ''}
        ${errors.length ? `<h4>Rejected rows</h4><ul class="import-list">${errorList}</ul>` : ''}
    `;
}

// FileReader rather than File.text(): the older WebView inside the native app
// has no File.text(), and the reader works everywhere.
function readFileText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = event => resolve(String(event.target.result || ''));
        reader.onerror = () => reject(reader.error || new Error('The file could not be read.'));
        reader.readAsText(file);
    });
}

// The search results are rebuilt after an import so the admin sees new data.
function clearVehicleSearchCache() {
    registryCache.clear();
}

async function refreshVehicleSearchResults() {
    const input = document.getElementById('adminSearch');
    if (input && input.value.trim()) document.getElementById('adminSearchBtn')?.click();
}

// Plate list from an uploaded CSV: every cell of the first column (the plate
// column in both the template and an exported registry export), ignoring a
// header row and blanks.
function parseVehiclePlateCsv(text) {
    const table = parseCsvText(text);
    const plates = [];
    const seen = new Set();
    table.forEach(cells => {
        const value = String((cells && cells[0]) || '').trim().toUpperCase().replace(/\s+/g, ' ');
        if (!value || /^VEHICLENUMBER$|^VEHICLE$|^PLATE$|^VEHICLE NO$/.test(value)) return;
        if (seen.has(value)) return;
        seen.add(value);
        plates.push(value);
    });
    return plates;
}

function bulkDeleteHeadline(summary) {
    return `${summary.society ? summary.society + ': ' : ''}bulk delete complete. Deleted ${summary.deleted || 0} of ${summary.requested || 0} vehicle(s)`
        + `, not found ${summary.notFound || 0}`
        + (summary.skipped ? `, skipped ${summary.skipped}` : '')
        + (summary.failed ? `, failed ${summary.failed}` : '') + '.';
}

function renderBulkDeleteReport(summary) {
    const report = document.getElementById('bulk-delete-report');
    if (!report) return;
    const rows = Array.isArray(summary.plates) ? summary.plates : [];
    const chip = (cls, text) => `<span class="delete-chip ${cls}">${escapeText(text)}</span>`;
    const list = rows.map(row => `<li><b>${escapeText(row.plate)}</b> — ${escapeText(row.action === 'deleted' ? 'Deleted' : row.action === 'notFound' ? 'Not found' : 'Skipped')}${row.reason ? ` <span class="import-reason">(${escapeText(row.reason)})</span>` : ''}</li>`).join('');
    report.innerHTML = `
        <div class="import-summary">
            ${chip('is-deleted', `Deleted ${summary.deleted || 0}`)}
            ${chip('is-missing', `Not found ${summary.notFound || 0}`)}
            ${summary.skipped ? chip('', `Skipped ${summary.skipped}`) : ''}
            ${summary.failed ? chip('is-deleted', `Failed ${summary.failed}`) : ''}
            ${chip('', `Rows ${summary.requested || 0}`)}
        </div>
        ${summary.truncated ? '<p class="small" style="color: var(--ow-danger);">Only the first 2000 plates were processed.</p>' : ''}
        ${rows.length ? `<h4>Per-vehicle result</h4><ul class="import-list">${list}</ul>` : ''}
    `;
}

// Exposed for the page's own handlers and for tests.
window.OwAdminBookings = {
    renderActiveBookings, loadActiveBookings, isExpiredBooking,
    formatBookingTime, BOOKING_RETENTION_DAYS
};
window.OwAdminVehicles = {
    parseCsvText, parseVehicleCsv, renderImportReport, importHeadline,
    parseVehiclePlateCsv, renderBulkDeleteReport, bulkDeleteHeadline
};

// Bulk delete and Export all data are master-login tools. Everything marked
// data-master-only starts hidden (inline style) and is revealed only for the
// master account, so a society admin never sees them even for a moment.
function applyMasterOnlyVisibility(isMaster) {
    document.querySelectorAll('[data-master-only]').forEach(element => {
        element.style.display = isMaster ? '' : 'none';
    });
    const masterOnlySection = document.getElementById('bulk-section');
    if (masterOnlySection) masterOnlySection.style.display = isMaster ? 'block' : 'none';
}
window.OwAdminMasterTools = { applyMasterOnlyVisibility };

// Flat numbers for the add/edit form come from the society, not free text: the
// field is a combobox backed by societies/:id/flats (a datalist keeps it usable
// as a dropdown on desktop and as a typeahead in the app's WebView).
let societyFlats = [];

function renderFlatOptions(flats) {
    societyFlats = Array.isArray(flats) ? flats.filter(Boolean) : [];
    const list = document.getElementById('flatNumberOptions');
    if (!list) return;
    list.innerHTML = societyFlats.map(flat => `<option value="${escapeHtml(flat)}"></option>`).join('');
    const hint = document.getElementById('fNumHint');
    if (hint) {
        hint.textContent = societyFlats.length
            ? `Choose from ${societyFlats.length} registered flat number(s) in this society.`
            : 'No flat numbers are registered for this society yet.';
    }
}

async function loadSocietyFlats() {
    if (!assignedSociety) return;
    try {
        const res = await authenticatedFetch(`${API_BASE_URL}/societies/${encodeURIComponent(assignedSociety)}/flats`);
        if (!res.ok) throw new Error(`Flat list failed (${res.status})`);
        const data = await res.json();
        renderFlatOptions(data.flats);
    } catch (err) {
        console.error("Failed to load society flat numbers:", err);
    }
}

window.OwAdminFlats = { loadSocietyFlats, renderFlatOptions, flats: () => [...societyFlats] };

document.addEventListener('DOMContentLoaded', () => {

    async function loadSocietyLimits() {
        if (!assignedSociety) return;
        try {
            const res = await authenticatedFetch(`${API_BASE_URL}/societies/${assignedSociety}`);
            if (res.ok) {
                const data = await res.json();
                const max4 = document.getElementById('max4WheelerInput');
                const max2 = document.getElementById('max2WheelerInput');
                if (max4) max4.value = Number.isInteger(data.max4Wheeler) ? data.max4Wheeler : '';
                if (max2) max2.value = Number.isInteger(data.max2Wheeler) ? data.max2Wheeler : '';
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
            if (typeof loadSocietyLimits === 'function') loadSocietyLimits();
            if (typeof loadSocietyFlats === 'function') loadSocietyFlats();

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
            <div class="time-field">
                <label for="startHour">Start time</label>
                ${buildTimeDropdownHTML('start')}
            </div>
            <div class="time-field">
                <label for="endHour">End time</label>
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

                    applyMasterOnlyVisibility(isMasterAdminUser);
                    if (isMasterAdminUser) {
                        localStorage.setItem("isAdminMaster", "true");

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
                        loadSocietyFlats();
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
        if (!email) return window.showModal("Pls enter email id");

        try {
            await sendPasswordResetEmail(auth, email);
        } catch (_) {
            // Do not reveal whether an address has an admin membership/account.
        }
        window.showModal("If an account is registered for that email, a password reset link will be sent.");
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

        if (endT <= startT) return window.showModal("The end time must be after the start time.");

        try {
            const res = await authenticatedFetch(`${API_BASE_URL}/bookings`, {
                method: 'POST',
                body: JSON.stringify({
                    society: assignedSociety,
                    facilityId: fId,
                    start: `${date}T${startT}:00`,
                    end: `${date}T${endT}:00`
                })
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `Booking failed (${res.status})`);
            }
            window.showModal("Booking created successfully!");
            loadActiveBookings();
        } catch (err) {
            window.showModal("Failed to create booking: " + (err.message || err));
        }
    });

    window.deleteBooking = async (bookingDocId) => {
        if (!bookingDocId) return;
        if (!window.confirm("Delete this booking? This cannot be undone.")) return;
        try {
            const res = await authenticatedFetch(`${API_BASE_URL}/bookings/${encodeURIComponent(bookingDocId)}`, { method: 'DELETE' });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `Delete failed (${res.status})`);
            }
            window.showModal("Booking deleted.");
            loadActiveBookings();
        } catch (err) {
            window.showModal("Failed to delete booking: " + (err.message || err));
        }
    };

    document.getElementById('importBtn')?.addEventListener('click', async () => {
        const file = document.getElementById('excelInput').files[0];
        if (!file) return window.showModal("Choose the CSV file to import.");
        if (!assignedSociety) return window.showModal("Your admin account is not assigned to a society yet.");

        const button = document.getElementById('importBtn');
        if (button) button.disabled = true;
        const report = document.getElementById('import-report');
        if (report) report.innerHTML = "<p class='small' style='color: var(--ow-muted);'>Reading and importing…</p>";

        try {
            const text = await readFileText(file);
            const rows = parseVehicleCsv(text);
            if (!rows.length) throw new Error("No vehicle rows found. The first line should be the header row.");

            clearVehicleSearchCache();
            const res = await authenticatedFetch(`${API_BASE_URL}/vehicles/import`, {
                method: 'POST',
                body: JSON.stringify({ society: assignedSociety, rows })
            });
            const summary = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(summary.error || `Import failed (${res.status})`);

            renderImportReport(summary);
            window.showModal(importHeadline(summary));
            // Registry changed: refresh whatever the admin is looking at.
            if (registryCache.size) refreshVehicleSearchResults();
        } catch (err) {
            if (report) report.innerHTML = "";
            window.showModal("Import failed: " + (err.message || err));
        } finally {
            if (button) button.disabled = false;
        }
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

    // --- Bulk delete from a CSV ---------------------------------------------
    // The confirm button used to call window.confirmDelete, which nothing set
    // unless this handler ran first, so the dialog's Confirm did nothing. Both
    // entry points (the danger-zone button and the one under the CSV picker)
    // now share one flow: confirm, post the plates once, then report.
    async function runBulkVehicleDelete() {
        const file = document.getElementById('excelInput').files[0];
        if (!file) return window.showModal("Choose the CSV file listing the vehicles to delete.");
        if (!assignedSociety) return window.showModal("Your admin account is not assigned to a society yet.");
        if (!window.confirm(`Delete every vehicle listed in "${file.name}" from ${assignedSociety}? This cannot be undone.`)) return;

        const button = document.getElementById('bulkDeleteTopBtn');
        const report = document.getElementById('bulk-delete-report');
        if (button) button.disabled = true;
        if (report) report.innerHTML = "<p class='small' style='color: var(--ow-muted);'>Deleting the listed vehicles…</p>";

        try {
            const text = await readFileText(file);
            const plates = parseVehiclePlateCsv(text);
            if (!plates.length) throw new Error("No vehicle numbers found in the file.");

            const res = await authenticatedFetch(`${API_BASE_URL}/vehicles/bulk-delete`, {
                method: 'POST',
                body: JSON.stringify({ society: assignedSociety, plates })
            });
            const summary = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(summary.error || `Bulk delete failed (${res.status})`);

            renderBulkDeleteReport(summary);
            window.showModal(bulkDeleteHeadline(summary));
            // The registry changed under any open search results.
            const results = document.getElementById('admin-results');
            if (results && registryCache.size) {
                registryCache.clear();
                if (document.getElementById('adminSearch').value.trim()) document.getElementById('adminSearchBtn')?.click();
            }
        } catch (err) {
            if (report) report.innerHTML = "";
            window.showModal("Bulk delete failed: " + (err.message || err));
        } finally {
            if (button) button.disabled = false;
        }
    }

    document.getElementById('bulkDeleteTopBtn')?.addEventListener('click', runBulkVehicleDelete);
    // The master-only danger-zone button keeps its original id and behaviour.
    document.getElementById('bulkDeleteBtn')?.addEventListener('click', runBulkVehicleDelete);

});