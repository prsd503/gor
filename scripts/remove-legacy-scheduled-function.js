#!/usr/bin/env node
/* Removes the retired `noticeRollover` scheduled Function from the Firebase
 * project, plus the Cloud Scheduler job that used to trigger it.
 *
 * Why this exists
 * ---------------
 * The notice rollover is no longer a scheduled Function: the master admin
 * portal posts to /api/maintenance/notices on demand, and GET /api/notices
 * computes the effective notice at read time even if nobody pressed the button.
 * The deployed `noticeRollover` was created by an older release, so it is not in
 * this repository any more - a `firebase deploy` can neither update it nor
 * remove it. Only the Cloud API can, which is what this script calls.
 *
 * Safe by design
 * --------------
 * - Dry run unless `--apply` is passed, so the default is a report.
 * - Never deletes `api`; that name is refused outright.
 * - Only deletes the names given on the command line (default:
 *   `noticeRollover`), never "everything that is not api".
 * - Deletes the Function first, then an orphaned
 *   `firebase-schedule-<name>-<region>` Scheduler job if one is still listed.
 *
 * Usage
 * -----
 *   node scripts/remove-legacy-scheduled-function.js            # report only
 *   node scripts/remove-legacy-scheduled-function.js --apply    # delete
 *   node scripts/remove-legacy-scheduled-function.js --apply otherOldJob
 *
 * Requires the Google Cloud CLI (`gcloud`) authenticated against the project.
 */
'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

const DEFAULT_PROJECT = 'finder-owl';
const DEFAULT_REGION = 'us-central1';
const DEFAULT_LEGACY_NAMES = ['noticeRollover'];
// The one Function this project must keep. Deleting it breaks the API.
const PROTECTED_NAMES = new Set(['api']);

function parseArgs(argv) {
    const options = {
        apply: false,
        project: process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT,
        region: process.env.FUNCTIONS_REGION || DEFAULT_REGION,
        names: []
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--apply') options.apply = true;
        else if (arg === '--dry-run') options.apply = false;
        else if (arg === '--project') options.project = argv[++index];
        else if (arg.startsWith('--project=')) options.project = arg.slice('--project='.length);
        else if (arg === '--region') options.region = argv[++index];
        else if (arg.startsWith('--region=')) options.region = arg.slice('--region='.length);
        else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        else options.names.push(arg);
    }
    if (options.help) return options;
    if (!options.names.length) options.names = [...DEFAULT_LEGACY_NAMES];
    const refused = options.help ? [] : options.names.filter(name => PROTECTED_NAMES.has(name));
    if (refused.length) {
        throw new Error(`Refusing to delete ${refused.join(', ')}: that is the live API Function.`);
    }
    return options;
}

async function gcloud(args) {
    try {
        const { stdout } = await run('gcloud', args, { maxBuffer: 8 * 1024 * 1024 });
        return stdout;
    } catch (error) {
        // A missing CLI is not "the Function is gone": say so instead of
        // reporting a clean result that would hide a still-running timer.
        if (error.code === 'ENOENT') {
            throw new Error('The Google Cloud CLI (`gcloud`) is not installed. Install it and run `gcloud auth login` before using this script.');
        }
        throw error;
    }
}

/* True when the CLI itself is unusable, so a failed lookup cannot be mistaken
 * for "nothing deployed". */
function isCliProblem(error) {
    return /Google Cloud CLI|not authenticated|gcloud auth/i.test(error && error.message || '');
}

/* Gen 1 and Gen 2 Functions live in different APIs, so a failed lookup in one
 * is not an error - it just means the Function is not that generation. */
async function describeFunction(name, options) {
    // Pass the generation explicitly: gcloud's default for `describe` differs
    // between versions, and an older CLI rejects the flag it does not know.
    const attempts = [
        { generation: 2, args: ['functions', 'describe', name, `--region=${options.region}`, `--project=${options.project}`, '--format=json', '--gen2'] },
        { generation: 2, args: ['functions', 'describe', name, `--region=${options.region}`, `--project=${options.project}`, '--format=json'] },
        { generation: 1, args: ['functions', 'describe', name, `--region=${options.region}`, `--project=${options.project}`, '--format=json', '--gen1'] }
    ];
    let unknown = null;
    for (const attempt of attempts) {
        try {
            const raw = await gcloud(attempt.args);
            return { exists: true, generation: attempt.generation, detail: JSON.parse(raw) };
        } catch (error) {
            if (isCliProblem(error)) throw error;
            // "not found" in this generation is expected; try the next one. A
            // permission error is neither found nor absent, so keep it.
            if (!/not found|NOT_FOUND|does not exist/i.test(error.message)) unknown = error;
        }
    }
    if (unknown) throw new Error(`Could not read the Function list: ${unknown.message.split('\n')[0]}`);
    return { exists: false, generation: null, detail: null };
}

async function listSchedulerJobs(options) {
    try {
        const raw = await gcloud(['scheduler', 'jobs', 'list', `--location=${options.region}`, `--project=${options.project}`, '--format=json']);
        return JSON.parse(raw || '[]');
    } catch (error) {
        if (isCliProblem(error)) throw error;
        // The Scheduler API may simply not be enabled for this project.
        if (/has not been used|is disabled|permission/i.test(error.message)) {
            console.log('Could not list Cloud Scheduler jobs (API disabled or no permission); check the console manually.');
            return [];
        }
        throw error;
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log('Remove a retired scheduled Function (default: noticeRollover) and its Scheduler job.');
        console.log('Usage: node scripts/remove-legacy-scheduled-function.js [--apply] [--project=ID] [--region=REGION] [name ...]');
        console.log('Without --apply it only reports what it would delete. Never deletes the api Function.');
        console.log('');
        console.log('Run it from a checkout of this repository (the folder that holds package.json),');
        console.log('or call the script directly by path - it needs no npm packages installed.');
        return 0;
    }
    const mode = options.apply ? 'DELETE' : 'report only (dry run)';
    console.log(`Project ${options.project}, region ${options.region} - ${mode}`);
    console.log(`Checking: ${options.names.join(', ')}\n`);

    const report = [];
    for (const name of options.names) {
        const found = await describeFunction(name, options);
        if (!found.exists) {
            report.push({ name, status: 'not deployed', action: 'nothing to do' });
            console.log(`- ${name}: not deployed. Nothing to do.`);
            continue;
        }
        const trigger = found.generation === 1 ? 'scheduled (gen 1)' : 'deployed (gen 2)';
        console.log(`- ${name}: ${trigger}`);
        if (!options.apply) {
            report.push({ name, status: 'present', action: 'would delete' });
            continue;
        }
        const args = ['functions', 'delete', name, `--region=${options.region}`, `--project=${options.project}`, '--quiet'];
        args.push(found.generation === 1 ? '--gen1' : '--gen2');
        await gcloud(args);
        console.log(`  deleted the Function.`);
        report.push({ name, status: 'deleted', action: 'function removed' });
    }

    const jobs = await listSchedulerJobs(options);
    const orphans = jobs.filter(job => options.names.some(name =>
        String(job.name || '').split('/').pop().startsWith(`firebase-schedule-${name}-`)));
    if (jobs.length && !orphans.length) console.log('\nNo orphaned Scheduler job for the retired Function.');
    for (const job of orphans) {
        const shortName = String(job.name).split('/').pop();
        if (!options.apply) {
            console.log(`\nScheduler job ${shortName}: present. Would delete.`);
            continue;
        }
        await gcloud(['scheduler', 'jobs', 'delete', shortName, `--location=${options.region}`, `--project=${options.project}`, '--quiet']);
        console.log(`\nScheduler job ${shortName}: deleted.`);
    }

    const remaining = await listSchedulerJobs(options);
    const firebaseTimers = remaining.filter(job => String(job.name || '').includes('firebase-schedule-'));
    if (firebaseTimers.length) {
        console.log('\nOther firebase-schedule jobs still present (not touched):');
        for (const job of firebaseTimers) console.log(`  ${String(job.name).split('/').pop()}`);
    }

    if (!options.apply) {
        console.log('\nDry run: nothing was deleted. Re-run with --apply to delete.');
        return 0;
    }
    const failed = report.filter(entry => entry.action === 'would delete');
    return failed.length ? 1 : 0;
}

if (require.main === module) {
    main().then(code => { process.exitCode = code; }).catch(error => {
        console.error(`Could not remove the retired Function: ${error.message}`);
        if (/ENOENT/.test(error.message)) console.error('Install the Google Cloud CLI and run `gcloud auth login` first.');
        process.exitCode = 1;
    });
}

module.exports = { parseArgs, PROTECTED_NAMES, DEFAULT_LEGACY_NAMES };
