// ============================================================
// CLOTH COUNTER — SINGLE CORE + WiFi Sync + OTA Upload
// 25+26 : sequential pass-through detection
// 27    : horse shoe appear→disappear detection
// 34    : current sensor (non-blocking)
// ============================================================

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoOTA.h>
#include <ArduinoJson.h>

// ============================================================
// WiFi + Server config
// ============================================================
const char* SSID         = "Clg Boys";
const char* PASSWORD     = "0987654321";
const char* SERVER_URL   = "https://netrat-1.onrender.com";  // NO trailing slash
const char* MACHINE_ID   = "MACHINE_001";
const char* FACTORY_ID   = "FACTORY_001";
const char* LINE_ID      = "LINE_001";
const char* MACHINE_TYPE = "input";

// ============================================================
// Pins
// ============================================================
#define IR_25               25
#define IR_26               26
#define IR_27               27
#define CURRENT_SENSOR_PIN  34

// ============================================================
// Current sensor
// ============================================================
#define SEN0211_VREF_MV     3300.0f
#define SEN0211_ADC_MAX     4095.0f
#define SEN0211_SENSITIVITY 50.0f
#define NOISE_FLOOR_AMPS    0.10f

#define CUR_SAMPLE_WINDOW_MS    40
#define CUR_SAMPLE_INTERVAL_MS  200

#define RUN_THRESHOLD_AMPS  0.80f
#define HYSTERESIS_AMPS     0.15f
#define CUR_MIN_RUN_MS      200

// ============================================================
// Timing
// ============================================================
#define DEBOUNCE_MS         30
#define PIN27_MIN_BLOCK_MS  150
#define SYNC_INTERVAL_MS    30000
#define STATUS_PRINT_MS     3000

// ============================================================
// State enums
// ============================================================
enum AB_State  { AB_IDLE, AB_GOT_25, AB_GOT_BOTH, AB_GOT_26_ONLY };
enum C27_State { C27_IDLE, C27_BLOCKED, C27_CONFIRMED };
enum CUR_State { CUR_IDLE, CUR_RUNNING };

const char* AB_STATE_NAMES[]  = { "AB_IDLE","AB_GOT_25","AB_GOT_BOTH","AB_GOT_26_ONLY" };
const char* C27_STATE_NAMES[] = { "C27_IDLE","C27_BLOCKED","C27_CONFIRMED" };

// ============================================================
// Debounced pin
// ============================================================
struct DebouncedPin {
    int           pin;
    bool          stableState;
    bool          lastRaw;
    unsigned long changeMs;

    DebouncedPin(int p) : pin(p), stableState(false),
                          lastRaw(false), changeMs(0) {}

    bool update() {
        bool raw = (digitalRead(pin) == LOW);
        if (raw != lastRaw) { lastRaw = raw; changeMs = millis(); }
        if ((millis() - changeMs >= DEBOUNCE_MS) && raw != stableState) {
            stableState = raw;
            return true;
        }
        return false;
    }
    bool blocked() { return stableState; }
};

DebouncedPin pin25(IR_25);
DebouncedPin pin26(IR_26);
DebouncedPin pin27(IR_27);

// ============================================================
// Counters & state
// ============================================================
AB_State      abState      = AB_IDLE;
unsigned long countAB      = 0;

C27_State     c27State     = C27_IDLE;
unsigned long count27      = 0;
unsigned long c27BlockedMs = 0;

CUR_State     curState      = CUR_IDLE;
unsigned long countCur      = 0;
unsigned long curRunStartMs = 0;
float         g_currentAmps = 0.0f;
unsigned long lastCurSampleMs = 0;

// ============================================================
// Dense current sampling
// ============================================================
void sampleCurrent() {
    int maxADC = 0, minADC = 4095;
    unsigned long t = millis();
    while (millis() - t < CUR_SAMPLE_WINDOW_MS) {
        int s = analogRead(CURRENT_SENSOR_PIN);
        if (s > maxADC) maxADC = s;
        if (s < minADC) minADC = s;
    }
    float Vpp  = (float)(maxADC - minADC) * (SEN0211_VREF_MV / SEN0211_ADC_MAX);
    float Vrms = (Vpp / 2.0f) * 0.707f;
    float amps = Vrms / SEN0211_SENSITIVITY;
    if (amps < NOISE_FLOOR_AMPS) amps = 0.0f;
    g_currentAmps = (g_currentAmps * 0.4f) + (amps * 0.6f);
}

// ============================================================
// Current cycle counter
// ============================================================
void updateCurrentCycle() {
    CUR_State prev = curState;

    switch (curState) {
        case CUR_IDLE:
            if (g_currentAmps >= RUN_THRESHOLD_AMPS) {
                curState      = CUR_RUNNING;
                curRunStartMs = millis();
            }
            break;

        case CUR_RUNNING:
            if (g_currentAmps < (RUN_THRESHOLD_AMPS - HYSTERESIS_AMPS)) {
                unsigned long ranFor = millis() - curRunStartMs;
                if (ranFor >= CUR_MIN_RUN_MS) {
                    countCur++;
                    Serial.printf("[CUR] +1  ran %lums  Total CUR: %lu\n", ranFor, countCur);
                } else {
                    Serial.printf("[CUR] Ignored — ran only %lums (need %dms)\n", ranFor, CUR_MIN_RUN_MS);
                }
                curState = CUR_IDLE;
            }
            break;
    }

    if (curState != prev)
        Serial.printf("[CUR] %s → %s  %.3fA\n",
                      prev == CUR_IDLE ? "IDLE" : "RUNNING",
                      curState == CUR_IDLE ? "IDLE" : "RUNNING",
                      g_currentAmps);
}

// ============================================================
// 25+26 sequential counter
// ============================================================
void updateAB() {
    bool b25 = pin25.blocked();
    bool b26 = pin26.blocked();
    AB_State prev = abState;

    switch (abState) {
        case AB_IDLE:
            if (b25 && !b26) abState = AB_GOT_25;
            break;
        case AB_GOT_25:
            if (b25 && b26)        abState = AB_GOT_BOTH;
            else if (!b25 && !b26) { Serial.println("[AB] Reset: 25 cleared early"); abState = AB_IDLE; }
            break;
        case AB_GOT_BOTH:
            if (!b25 && b26)       abState = AB_GOT_26_ONLY;
            else if (!b25 && !b26) { countAB++; Serial.printf("[AB] +1 (fast)  Total AB: %lu\n", countAB); abState = AB_IDLE; }
            break;
        case AB_GOT_26_ONLY:
            if (!b26)     { countAB++; Serial.printf("[AB] +1 COUNTED  Total AB: %lu\n", countAB); abState = AB_IDLE; }
            else if (b25) { Serial.println("[AB] Reset: cloth reversed"); abState = AB_IDLE; }
            break;
    }

    if (abState != prev)
        Serial.printf("[AB] %s → %s  (b25=%d b26=%d)\n",
                      AB_STATE_NAMES[prev], AB_STATE_NAMES[abState], b25, b26);
}

// ============================================================
// Horse shoe counter (pin 27)
// ============================================================
void update27(bool changed) {
    if (c27State == C27_BLOCKED) {
        if (millis() - c27BlockedMs >= PIN27_MIN_BLOCK_MS) {
            Serial.println("[27] C27_BLOCKED → C27_CONFIRMED");
            c27State = C27_CONFIRMED;
        }
    }
    if (!changed) return;

    bool blocked  = pin27.blocked();
    C27_State prev = c27State;

    switch (c27State) {
        case C27_IDLE:
            if (blocked) { c27State = C27_BLOCKED; c27BlockedMs = millis(); }
            break;
        case C27_BLOCKED:
            if (!blocked) { Serial.println("[27] Ignored: gone before MIN_BLOCK_MS"); c27State = C27_IDLE; }
            break;
        case C27_CONFIRMED:
            if (!blocked) { count27++; Serial.printf("[27] +1 COUNTED  Total 27: %lu\n", count27); c27State = C27_IDLE; }
            break;
    }

    if (c27State != prev)
        Serial.printf("[27] %s → %s\n", C27_STATE_NAMES[prev], C27_STATE_NAMES[c27State]);
}

// ============================================================
// WiFi
// ============================================================
void connectWiFi() {
    if (WiFi.status() == WL_CONNECTED) return;
    Serial.printf("[WiFi] Connecting to %s", SSID);
    WiFi.mode(WIFI_STA);
    WiFi.begin(SSID, PASSWORD);
    int tries = 0;
    while (WiFi.status() != WL_CONNECTED && tries < 20) {
        delay(500);
        Serial.print(".");
        tries++;
    }
    if (WiFi.status() == WL_CONNECTED)
        Serial.printf("\n[WiFi] Connected — IP: %s\n", WiFi.localIP().toString().c_str());
    else
        Serial.println("\n[WiFi] Failed — will retry");
}

// ============================================================
// Sync to server
// FIX 1: SERVER_URL has no trailing slash — URL is now correct
// FIX 2: Wake ping wakes Render's free-tier cold start (50s timeout)
// FIX 3: Sync timeout raised to 15s after server is confirmed awake
// ============================================================
void syncWithServer() {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[SYNC] No WiFi — skipping");
        return;
    }

    // ── Wake ping: brings Render out of sleep before syncing ──
    Serial.println("[SYNC] Waking server...");
    HTTPClient wake;
    wake.begin(String(SERVER_URL) + "/healthz");
    wake.setTimeout(50000);                      // 50s covers cold-start
    int wakeCode = wake.GET();
    wake.end();
    Serial.printf("[SYNC] Wake ping: HTTP %d\n", wakeCode);

    if (wakeCode <= 0) {
        Serial.println("[SYNC] Server unreachable — skipping sync");
        return;
    }

    // ── Main sync POST ────────────────────────────────────────
    DynamicJsonDocument doc(256);
    doc["machineId"]   = MACHINE_ID;
    doc["factoryId"]   = FACTORY_ID;
    doc["lineId"]      = LINE_ID;
    doc["machineType"] = MACHINE_TYPE;
    doc["countAB"]     = countAB;
    doc["count27"]     = count27;
    doc["countCur"]    = countCur;
    doc["countOutput"] = 0;
    doc["currentAmps"] = g_currentAmps;
    doc["timestamp"]   = millis();

    String payload;
    serializeJson(doc, payload);

    HTTPClient http;
    http.begin(String(SERVER_URL) + "/api/machines/sync");
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(15000);
    int code = http.POST(payload);
    Serial.printf("[SYNC] %s — HTTP %d\n", code > 0 ? "OK" : "Failed", code);
    http.end();
}

// ============================================================
// OTA
// ============================================================
void setupOTA() {
    ArduinoOTA.setHostname("cloth-counter-input");
    ArduinoOTA.onStart([](){ Serial.println("[OTA] Starting..."); });
    ArduinoOTA.onEnd([](){ Serial.println("\n[OTA] Done — rebooting"); });
    ArduinoOTA.onProgress([](unsigned int p, unsigned int t){ Serial.printf("[OTA] %u%%\r", p * 100 / t); });
    ArduinoOTA.onError([](ota_error_t e){ Serial.printf("[OTA] Error %u\n", e); });
    ArduinoOTA.begin();
    Serial.println("[OTA] Ready");
}

// ============================================================
// SETUP
// ============================================================
void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println("\n===== CLOTH COUNTER BOOT =====");
    Serial.printf("Machine: %s | Line: %s\n", MACHINE_ID, LINE_ID);
    Serial.println("Counter 1 — 25+26  : sequential pass");
    Serial.println("Counter 2 — Pin 27 : horse shoe");
    Serial.printf ("Counter 3 — Amps   : RUN(>%.2fA)→IDLE = +1\n", RUN_THRESHOLD_AMPS);
    Serial.println("Send R to reset all counts");
    Serial.println("==============================\n");

    pinMode(IR_25, INPUT_PULLUP);
    pinMode(IR_26, INPUT_PULLUP);
    pinMode(IR_27, INPUT_PULLUP);

    lastCurSampleMs = millis();
    connectWiFi();
    setupOTA();
    Serial.println("Ready.\n");
}

// ============================================================
// MAIN LOOP — single core
// ============================================================
unsigned long lastStatusMs = 0;
unsigned long lastSyncMs   = 0;

void loop() {
    ArduinoOTA.handle();
    if (WiFi.status() != WL_CONNECTED) connectWiFi();

    // ── Current: dense burst sample + cycle check every 200ms ──
    if (millis() - lastCurSampleMs >= CUR_SAMPLE_INTERVAL_MS) {
        lastCurSampleMs = millis();
        sampleCurrent();
        updateCurrentCycle();
    }

    // ── IR debounce + independent state machines ──────────────
    bool changed25 = pin25.update();
    bool changed26 = pin26.update();
    bool changed27 = pin27.update();

    if (changed25 || changed26) updateAB();
    update27(changed27);

    // ── Status every 3s ───────────────────────────────────────
    if (millis() - lastStatusMs >= STATUS_PRINT_MS) {
        lastStatusMs = millis();
        Serial.printf("[STATUS] AB:%-4lu | 27:%-4lu | CUR:%-4lu | %.3fA | %s | WiFi:%s\n",
                      countAB, count27, countCur, g_currentAmps,
                      curState == CUR_RUNNING ? "RUNNING" : "idle",
                      WiFi.status() == WL_CONNECTED ? "OK" : "DOWN");
    }

    // ── Sync every 30s ────────────────────────────────────────
    if (millis() - lastSyncMs >= SYNC_INTERVAL_MS) {
        lastSyncMs = millis();
        syncWithServer();
    }

    // ── R resets all ──────────────────────────────────────────
    if (Serial.available() && Serial.read() == 'R') {
        countAB = count27 = countCur = 0;
        abState  = AB_IDLE;
        c27State = C27_IDLE;
        curState = CUR_IDLE;
        Serial.println("[RESET] All counts zeroed");
    }
}
