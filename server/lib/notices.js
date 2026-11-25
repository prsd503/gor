'use strict';

// India does not observe daylight saving time. Notice cycles follow the
// calendar day in IST, starting at midnight.
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
function istDate(now = new Date()) {
    return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
function noticeCycle(now = new Date()) {
    return istDate(now);
}
function effectiveNotice(data, now = new Date()) {
    const cycle = noticeCycle(now);
    // Older records used date as the date of the last shift/save.
    const previous = data.noticeCycle || data.date;
    let todayMessage = data.todayMessage || '';
    let tomorrowMessage = data.tomorrowMessage || '';
    const due = /^\d{4}-\d{2}-\d{2}$/.test(previous || '') && previous < cycle;
    if (due) {
        const days = (Date.parse(cycle + 'T00:00:00Z') - Date.parse(previous + 'T00:00:00Z')) / DAY_MS;
        todayMessage = days === 1 ? tomorrowMessage : '';
        tomorrowMessage = '';
    }
    return { date: istDate(now), todayMessage, tomorrowMessage, noticeCycle: cycle, due };
}
module.exports = { istDate, noticeCycle, effectiveNotice };
