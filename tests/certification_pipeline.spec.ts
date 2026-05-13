import { test, expect } from '@playwright/test';

// ══════════════════════════════════════════════════════════════
// CERTIFICATION PIPELINE — CDS + OCTT (Playwright)
// ══════════════════════════════════════════════════════════════

const CONFIG = {
    dashboardUrl: 'http://127.0.0.1:3101/api',
    octtBaseUrl: process.env.OCTT_BASE_URL ? `${process.env.OCTT_BASE_URL}/api/v1` : '',
    octtToken: process.env.OCTT_TOKEN ?? '',
    cdsIp: process.env.CDS_IP ?? '192.168.100.10',
    cdsPort: parseInt(process.env.CDS_PORT ?? '51001', 10),
    sinkId: 12,
    configurationName: process.env.OCTT_CONFIG ?? 'AUT_SID_SAT',
} as const;

const cdsId = `cds-${CONFIG.cdsIp.replace(/\./g, '-')}-${CONFIG.cdsPort}`;

const authHeader = { Authorization: `Bearer ${CONFIG.octtToken}` };

const testSuites: Record<string, string[]> = {
    'MAINTENANCE': [
        'tc_bi_restore_configuration', 'tc_bi_stop_transactions', 'tc_bi_clear_cache',
        'tc_bi_clear_local_auth_list', 'tc_bi_restore_availability', 'tc_bi_reset_hard',
    ],
    'Authorization': ['TC_023_4_CS', 'TC_023_5_CS', 'TC_024_CS', 'TC_061_1_CS', 'TC_061_2_CS'],
    'DataTransfer': ['TC_062_CS'],
    'FirmwareManagement': ['TC_044_1_CS', 'TC_044_2_CS', 'TC_044_3_CS', 'TC_045_1_CS', 'TC_045_2_CS'],
    'LocalAuthList': ['TC_008_1_CS', 'TC_008_2_CS', 'TC_042_1_CS', 'TC_042_2_CS', 'TC_043_1_CS', 'TC_043_2_CS', 'TC_043_3_CS', 'TC_043_CS'],
    'MeterValues': ['TC_070_CS', 'TC_071_CS'],
    'Provisioning': ['TC_001_CS', 'TC_002_CS', 'TC_013_CS', 'TC_014_CS', 'TC_015_CS', 'TC_016_CS', 'TC_019_CS', 'TC_021_CS', 'TC_032_1_CS', 'TC_032_2_CS', 'TC_034_CS', 'TC_040_1_CS', 'TC_040_2_CS', 'TC_041_CS'],
    'RemoteControl': ['TC_010_CS', 'TC_011_1_CS', 'TC_011_2_CS', 'TC_012_CS', 'TC_017_1_CS', 'TC_017_2_CS', 'TC_018_1_CS', 'TC_018_2_CS', 'TC_026_CS', 'TC_027_CS', 'TC_028_CS', 'TC_030_CS', 'TC_031_CS'],
    'RemoteTrigger': ['TC_054_CS', 'TC_055_CS'],
    'Reservation': ['TC_046_1_CS', 'TC_046_2_CS', 'TC_047_CS', 'TC_048_1_CS', 'TC_048_2_CS', 'TC_048_3_CS', 'TC_048_4_CS', 'TC_049_CS', 'TC_050_1_CS', 'TC_050_2_CS', 'TC_050_3_CS', 'TC_050_4_CS', 'TC_051_CS', 'TC_052_CS', 'TC_053_1_CS', 'TC_053_2_CS'],
    'Security': ['TC_073_CS', 'TC_074_CS', 'TC_075_1_CS', 'TC_075_2_CS', 'TC_076_CS', 'TC_077_CS', 'TC_078_CS', 'TC_079_CS', 'TC_080_CS', 'TC_081_CS', 'TC_083_CS', 'TC_084_CS', 'TC_085_CS', 'TC_086_CS', 'TC_087_CS'],
    'SmartCharging': ['TC_056_CS', 'TC_057_CS', 'TC_058_1_CS', 'TC_058_2_CS', 'TC_059_CS', 'TC_060_CS', 'TC_066_CS', 'TC_067_CS', 'TC_072_CS', 'TC_082_CS'],
    'Transactions': ['TC_003_CS', 'TC_004_1_CS', 'TC_004_2_CS', 'TC_005_1_CS', 'TC_005_2_CS', 'TC_005_3_CS', 'TC_007_1_CS', 'TC_007_2_CS', 'TC_036_CS', 'TC_037_1_CS', 'TC_037_2_CS', 'TC_037_3_CS', 'TC_038_CS', 'TC_039_CS', 'TC_068_CS', 'TC_069_CS'],
};

const chargingSuites = ['Transactions', 'RemoteControl', 'SmartCharging', 'Reservation'];

function needsCdsReset(suite: string, testId: string): boolean {
    if (chargingSuites.includes(suite)) return true;
    if (testId.startsWith('TC_017') || testId.startsWith('TC_018')) return true;
    if (testId.startsWith('TC_008') || testId.startsWith('TC_007')) return true;
    return false;
}

async function resetCdsBetweenTests(request: any) {
    console.log('[CDS] Reset between tests...');
    try {
        await request.post(`${CONFIG.dashboardUrl}/i/${cdsId}/stop`);
        await new Promise(r => setTimeout(r, 2000));
        await request.post(`${CONFIG.dashboardUrl}/i/${cdsId}/reset`);
        await new Promise(r => setTimeout(r, 3000));
        await request.post(`${CONFIG.dashboardUrl}/i/${cdsId}/start`);
        console.log('[CDS] Reset complete, simulation restarted');
    } catch {
        console.log('[CDS] Reset error (non-fatal)');
    }
}

const results: { suite: string; testCase: string; verdict: string; duration: number }[] = [];
let sessionStarted = false;

test.describe.configure({ mode: 'serial' });
test.setTimeout(600_000);

// ── Phase 0: Lab Setup ──

test('0a. Regista instância CDS no dashboard', async ({ request }) => {
    const resp = await request.post(`${CONFIG.dashboardUrl}/instances`, {
        data: { id: cdsId, ip: CONFIG.cdsIp, port: CONFIG.cdsPort },
    });
    expect(resp.status()).toBe(200);
});

test('0b. Configura CDS (ISO 15118, DC, sink)', async ({ request }) => {
    const resp = await request.post(`${CONFIG.dashboardUrl}/i/${cdsId}/configure-cds`, {
        data: { specification: 3, chargeMode: 2, sinkId: CONFIG.sinkId, mode: 2 },
    });
    const body = await resp.json();
    expect(body.ok).toBeTruthy();
});

test('0c. Configura parâmetros EV (900V, 300A, 50kW)', async ({ request }) => {
    const resp = await request.post(`${CONFIG.dashboardUrl}/i/${cdsId}/configure-ev`, {
        data: {
            EVMaximumVoltageLimit: 900,
            EVMinimumVoltageLimit: 800,
            EVMaximumCurrentLimit: 300,
            EVMinimumCurrentLimit: 0,
            EVMaximumPowerLimit: 50000,
            BatteryCapacity: 50000,
            EVstateOfCharge: 20,
        },
    });
    const body = await resp.json();
    expect(body.ok).toBeTruthy();
});

test('0d. Reset + Start CDS', async ({ request }) => {
    await request.post(`${CONFIG.dashboardUrl}/i/${cdsId}/reset`);
    await new Promise(r => setTimeout(r, 3000));
    await request.post(`${CONFIG.dashboardUrl}/i/${cdsId}/start`);
    console.log('[CDS] Simulação EV iniciada');
});

// ── Phase 1: OCTT Session ──

test('1. Inicia sessão OCTT', async ({ request }) => {
    const resp = await request.post(
        `${CONFIG.octtBaseUrl}/configurations/${CONFIG.configurationName}/sessions`,
        { headers: authHeader }
    );
    if (!resp.ok()) {
        const err = await resp.text();
        console.warn(`[OCTT] Start session warning (${resp.status()}): ${err.slice(0, 300)}`);
    }
    sessionStarted = true;
    console.log(`[OCTT] Sessão iniciada: ${CONFIG.configurationName}`);
});

// ── Phase 2: Execute all test suites ──

Object.entries(testSuites).forEach(([suiteName, tests]) => {
    test.describe(`Suite: ${suiteName}`, () => {

        for (const testId of tests) {

            test(`Execute ${testId}`, async ({ request }) => {
                console.log(`[OCTT] Executando ${testId}...`);

                const resp = await request.post(
                    `${CONFIG.octtBaseUrl}/testcases/${testId}/execute`,
                    { headers: authHeader, timeout: 180_000 }
                );

                if (!resp.ok()) {
                    console.error(`[ERROR] ${testId} HTTP ${resp.status()}`);
                    results.push({ suite: suiteName, testCase: testId, verdict: 'error', duration: 0 });
                    console.log(`  → ERROR (0s)`);
                    console.log(`[CDS] Resetting before next test...`);
                    await resetCdsBetweenTests(request);
                    return;
                }

                const body = await resp.json();
                const verdict = (body.data?.[0]?.verdict ?? 'ERROR').toLowerCase();
                const duration = body.data?.[0]?.duration ?? 0;

                results.push({ suite: suiteName, testCase: testId, verdict, duration });
                console.log(`  → ${verdict.toUpperCase()} (${duration}s)`);

                if (!testId.startsWith('tc_bi_') && needsCdsReset(suiteName, testId)) {
                    console.log(`[CDS] Resetting before next test...`);
                    await resetCdsBetweenTests(request);
                }
            });
        }
    });
});

// ── Phase 3: Tear down ──

test.afterAll(async ({ request }) => {
    console.log('\n══════════════════════════════════════════');
    console.log('           CERTIFICATION SUMMARY           ');
    console.log('══════════════════════════════════════════');

    const passed = results.filter(r => r.verdict === 'pass').length;
    const failed = results.filter(r => r.verdict === 'fail').length;
    const inconc = results.filter(r => r.verdict === 'inconc').length;
    const errors = results.filter(r => r.verdict === 'error').length;
    const total = results.length;

    console.log(`Total: ${total} | PASS: ${passed} | FAIL: ${failed} | INCONC: ${inconc} | ERROR: ${errors}`);
    console.log(`Pass rate: ${total > 0 ? Math.round((passed / total) * 100) : 0}%\n`);

    for (const r of results) {
        if (r.verdict !== 'pass') {
            console.log(`  ❌ [${r.suite}] ${r.testCase} → ${r.verdict.toUpperCase()}`);
        }
    }

    // Parar sessão OCTT
    if (sessionStarted) {
        try {
            const resp = await request.post(
                `${CONFIG.octtBaseUrl}/configurations/${CONFIG.configurationName}/sessions/stop`,
                { headers: authHeader }
            );
            console.log(`\n[OCTT] Sessão parada (${resp.status()})`);
        } catch {
            console.log('[OCTT] Erro ao parar sessão');
        }
    }

    // Cleanup CDS
    console.log('\n🛡️ CDS Cleanup...');
    try {
        await request.post(`${CONFIG.dashboardUrl}/i/${cdsId}/stop`);
        await new Promise(r => setTimeout(r, 2000));
        await request.post(`${CONFIG.dashboardUrl}/i/${cdsId}/reset`);
        console.log('[CDS] Parada e reset concluído');
    } catch {
        console.log('[CDS] Cleanup error (non-fatal)');
    }
});
