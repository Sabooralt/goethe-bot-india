import puppeteer from "puppeteer";
import axios from "axios";
import dns from "dns";
import http from "http";
import https from "https";

// DNS Pre-resolution
dns.resolve4("www.goethe.de", (err, addresses) => {
  if (!err && addresses.length > 0) {
    console.log(`⚡ DNS pre-resolved: goethe.de -> ${addresses[0]}`);
  }
});

// Keep-alive config for faster API calls
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50,
  keepAliveMsecs: 30000,
});
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  keepAliveMsecs: 30000,
  rejectUnauthorized: false,
});
axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;

interface ExamData {
  oid?: string;
  modules?: any[];
  bookFromStamp?: string;
  bookToStamp?: string;
  eventName?: string;
  locationName?: string;
  [key: string]: any;
}

interface ApiResponse {
  DATA?: ExamData[];
  [key: string]: any;
}

interface PollingOptions {
  interval?: number;
  onOidFound?: (oid: string, exam: ExamData) => Promise<void>;
  onTimeout?: () => void;
  maxDurationMs?: number;
}

class ExamApiMonitor {
  private apiUrl: string | null = "https://www.goethe.de/rest/examfinder/exams/institute/O%2010000366?category=E006&type=ER&countryIsoCode=pk&locationName=&count=10&start=1&langId=1&timezone=47&isODP=0&sortField=startDate&sortOrder=ASC&dataMode=0&langIsoCodes=en";
  private timeoutInterval: NodeJS.Timeout | null = null;
  private isPolling = false;
  private shouldStopPolling = false;
  private processingOid = false;
  private processedOids = new Set<string>();
  private consecutiveErrors = 0;
  private maxConsecutiveErrors = 5;
  private lastSuccessfulPoll: Date | null = null;

  async captureApiUrl(
    maxRetries = 30,
    retryDelay = 5000
  ): Promise<string | null> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`🌐 Attempt ${attempt}/${maxRetries}: Capturing API URL...`);
      let browser = null;

      try {
        browser = await puppeteer.launch({
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-blink-features=AutomationControlled",
          ],
          timeout: 30000,
        });

        const page = await browser.newPage();
        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        );

        const apiUrl = await new Promise<string | null>(async (resolve) => {
          let captured = false;
          const timeoutId = setTimeout(() => {
            if (!captured) resolve(null);
          }, 25000);

          page.on("response", (response) => {
            const url = response.url();
            if (!captured && url.includes("examfinder")) {
              captured = true;
              clearTimeout(timeoutId);
              resolve(url);
            }
          });

          try {
            await page.goto("https://www.goethe.de/ins/in/en/spr/prf/gzb2.cfm", {
              waitUntil: "networkidle0",
              timeout: 20000,
            });

          } catch (err) {

            console.log("Error capturing url:", err)

          }

          await new Promise((r) => setTimeout(r, 3000));
          if (!captured) {
            clearTimeout(timeoutId);
            resolve(null);
          }
        });

        await browser.close();

        if (apiUrl) {
          console.log(`✅ API URL captured: ${apiUrl}`);
          this.apiUrl = apiUrl;
          this.consecutiveErrors = 0;
          return apiUrl;
        }
      } catch (err) {
        console.error(`❌ Error capturing API URL (attempt ${attempt})`);
        if (browser) await browser.close().catch(() => { });
      }

      if (attempt < maxRetries) {
        const wait = Math.min(retryDelay * attempt, 15000);
        await new Promise((r) => setTimeout(r, wait));
      }
    }

    console.error(`❌ Failed to capture API URL after ${maxRetries} attempts`);
    return null;
  }

  private async directApiCall(): Promise<ApiResponse | null> {
    if (!this.apiUrl) return null;
    try {
      const response = await axios.get(this.apiUrl, { timeout: 5000 });
      this.consecutiveErrors = 0;
      this.lastSuccessfulPoll = new Date();
      return response.data;
    } catch {
      this.consecutiveErrors++;
      return null;
    }
  }

  private async checkAndRecaptureApiUrl(): Promise<boolean> {
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      console.warn(
        `⚠️ ${this.consecutiveErrors} consecutive errors → recapturing API URL...`
      );
      this.apiUrl = null;
      const newUrl = await this.captureApiUrl(5, 3000);
      if (newUrl) {
        console.log("✅ Successfully recaptured API URL");
        this.consecutiveErrors = 0;
        return true;
      }
      console.error("❌ Failed to recapture API URL");
      return false;
    }
    return true;
  }

  // MODIFIED: Simple polling for ANY exam with OID (no date/time filtering)
  async startPolling(options: PollingOptions = {}) {
    const {
      interval = 1000, // Very aggressive 1 second polling
      onOidFound,
      onTimeout,
      maxDurationMs = 30 * 60 * 1000, // 30 minutes default
    } = options;

    this.shouldStopPolling = false;
    this.processingOid = false;
    this.processedOids.clear();

    if (!this.apiUrl) {
      console.log("📡 Capturing API URL before polling...");
      await this.captureApiUrl();
      if (!this.apiUrl) {
        console.error("❌ Could not capture API URL. Exiting polling.");
        if (onTimeout) await onTimeout();
        return;
      }
    }

    console.log(`🚀 Starting OID polling (checking every ${interval}ms)...`);

    this.isPolling = true;

    this.timeoutInterval = setTimeout(async () => {
      console.log("⏰ Max polling duration reached");
      this.shouldStopPolling = true;
      this.stopPolling();
      if (onTimeout) await onTimeout();
    }, maxDurationMs);

    const rapidPoll = async () => {
      if (this.shouldStopPolling) return this.stopPolling();
      if (this.processingOid) return setTimeout(rapidPoll, interval);

      const canContinue = await this.checkAndRecaptureApiUrl();
      if (!canContinue) {
        this.stopPolling();
        if (onTimeout) await onTimeout();
        return;
      }

      try {
        const data = await this.directApiCall();

        if (!data?.DATA) {
          setTimeout(rapidPoll, interval);
          return;
        }

        // SIMPLIFIED: Just check for ANY exam with OID
        const examsWithOid = data.DATA.filter((exam) => exam.oid);

        if (examsWithOid.length > 0) {
          // Take the first exam with OID
          const exam = examsWithOid[0];

          if (!this.processedOids.has(exam.oid!)) {
            console.log(`🎯 OID FOUND: ${exam.oid}`);
            console.log(`📍 Location: ${exam.locationName || "Unknown"}`);
            console.log(`📅 Event: ${exam.eventName || "Unknown"}`);

            this.processedOids.add(exam.oid!);
            this.processingOid = true;

            // INSTANT CALLBACK - NO WAITING
            if (onOidFound) {
              setImmediate(() => {
                onOidFound(exam.oid!, exam).finally(() => {
                  this.processingOid = false;
                });
              });
            }

            // Stop polling after first OID found
            return this.stopPolling();
          }
        } else {
          console.log(
            `⏳ Polling... (${data.DATA.length} exams, no OID found yet)`
          );
        }
      } catch (err) {
        this.consecutiveErrors++;
        console.error("❌ Polling error:", err);
      }

      setTimeout(rapidPoll, interval);
    };

    setImmediate(rapidPoll);
  }

  stopPolling() {
    if (this.timeoutInterval) clearTimeout(this.timeoutInterval);
    if (this.isPolling) {
      this.isPolling = false;
      this.shouldStopPolling = true;
      console.log("🛑 Polling stopped");
    }
  }

  async forceStopPolling(maxWaitMs = 5000) {
    this.shouldStopPolling = true;
    this.stopPolling();
    const start = Date.now();
    while (this.processingOid && Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  getApiUrl() {
    return this.apiUrl;
  }

  getStatus() {
    return {
      isPolling: this.isPolling,
      apiUrl: this.apiUrl,
      processingOid: this.processingOid,
      processedOids: Array.from(this.processedOids),
      consecutiveErrors: this.consecutiveErrors,
      lastSuccessfulPoll: this.lastSuccessfulPoll,
    };
  }

  async destroy() {
    await this.forceStopPolling();
    this.apiUrl = null;
    this.processedOids.clear();
    this.consecutiveErrors = 0;
  }
}

export const examMonitor = new ExamApiMonitor();
export { ExamApiMonitor };
