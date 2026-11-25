'use strict';

const { istDate } = require('./notices');
const DAY_MS = 24 * 60 * 60 * 1000;
function utcDate(date = new Date()) {
    return date.toISOString().slice(0, 10);
}
function attemptDates(now = new Date()) {
    const previous = new Date(now.getTime() - DAY_MS);
    // Include legacy UTC keys so a pending win can still be claimed on rollout.
    return [...new Set([istDate(now), istDate(previous), utcDate(now), utcDate(previous)])];
}
function isSameIstDay(attempt, today) {
    if (attempt.timeZone === 'Asia/Kolkata' && typeof attempt.date === 'string') return attempt.date === today;
    const timestamp = attempt.createdAt;
    const date = timestamp && typeof timestamp.toDate === 'function' ? timestamp.toDate() : new Date(timestamp || NaN);
    // If the old record has no usable timestamp, fail closed rather than grant
    // a second spin when the UTC and IST date keys differ.
    return Number.isNaN(date.getTime()) || istDate(date) === today;
}
module.exports = { utcDate, attemptDates, isSameIstDay };
