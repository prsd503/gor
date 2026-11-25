'use strict';
const crypto = require('node:crypto');
const MAX_VEHICLES = 1000000;
function registrationLockId(societyId) {
    return crypto.createHash('sha256').update(String(societyId)).digest('hex');
}
function totalVehicleLimit(data) {
    const value = data && data.maxTotalVehicles;
    return Number.isSafeInteger(value) && value >= 0 && value <= MAX_VEHICLES ? value : null;
}
module.exports = { registrationLockId, totalVehicleLimit, MAX_VEHICLES };
