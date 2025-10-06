import puppeteer from "puppeteer";
import axios, { AxiosError } from "axios";

interface ExamModule {
  date: string;
  startTime: string;
}

interface ExamData {
  oid?: string;
  modules?: ExamModule[];
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
  onExamFound?: (exam: ExamData) => void;
  onExamWithOid?: (exam: ExamData) => Promise<void>;
  onTimeout?: () => void;
  stopOnFirstOid?: boolean;
  maxDurationMs?: number;
  priorityLocations?: string[];
}

class ExamApiMonitor {
  private apiUrl: string | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
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
      console.log(`🔍 Attempt ${attempt}/${maxRetries}: Capturing API URL...`);

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
            "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          ],
          timeout: 30000,
        });

        const page = await browser.newPage();

        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        );
        await page.setViewport({ width: 1920, height: 1080 });

        const apiUrl = await new Promise<string | null>(async (resolve) => {
          let apiUrlCaptured = false;
          const timeoutId = setTimeout(() => {
            if (!apiUrlCaptured) {
              resolve(null);
            }
          }, 25000);

          page.on("response", async (response) => {
            if (apiUrlCaptured) return;

            const url = response.url();
            if (url.includes("examfinder")) {
              console.log("✅ Captured API URL:", url);
              this.apiUrl = url;
              apiUrlCaptured = true;
              clearTimeout(timeoutId);
              resolve(url);
            }
          });

          try {
            await page.goto(
              "https://www.goethe.de/ins/in/en/spr/prf/gzb2.cfm",
              {
                waitUntil: "networkidle0",
                timeout: 20000,
              }
            );

            await new Promise((resolve) => setTimeout(resolve, 3000));

            if (!apiUrlCaptured) {
              clearTimeout(timeoutId);
              resolve(null);
            }
          } catch (error) {
            clearTimeout(timeoutId);
            resolve(null);
          }
        });

        await browser.close();

        if (apiUrl) {
          console.log(`✅ API URL captured on attempt ${attempt}`);
          this.consecutiveErrors = 0;
          return apiUrl;
        }
      } catch (error) {
        console.error(`❌ Browser error on attempt ${attempt}:`, error);
        if (browser) {
          try {
            await browser.close();
          } catch (e) {}
        }
      }

      if (attempt < maxRetries) {
        const waitTime = Math.min(retryDelay * attempt, 15000);
        console.log(`⏳ Waiting ${waitTime}ms before retry...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    console.error(`❌ Failed to capture API URL after ${maxRetries} attempts`);
    return null;
  }

  private prioritizeExams(
    exams: ExamData[],
    priorityLocations: string[]
  ): ExamData[] {
    if (!priorityLocations || priorityLocations.length === 0) {
      return exams;
    }

    return exams.sort((a, b) => {
      const aLocation = a.locationName?.toLowerCase() || "";
      const bLocation = b.locationName?.toLowerCase() || "";

      let aPriority = -1;
      let bPriority = -1;

      priorityLocations.forEach((location, index) => {
        const lowerLocation = location.toLowerCase();
        if (aLocation.includes(lowerLocation) && aPriority === -1) {
          aPriority = index;
        }
        if (bLocation.includes(lowerLocation) && bPriority === -1) {
          bPriority = index;
        }
      });

      if (aPriority !== -1 && bPriority !== -1) {
        return aPriority - bPriority;
      }

      if (aPriority !== -1) return -1;
      if (bPriority !== -1) return 1;

      return 0;
    });
  }

  private async makeApiRequest(retries = 3): Promise<ApiResponse | null> {
    if (!this.apiUrl) return null;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await axios.get(this.apiUrl, {
          timeout: 8000,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Accept: "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
          },
          validateStatus: (status) => status < 500,
        });

        this.consecutiveErrors = 0;
        this.lastSuccessfulPoll = new Date();

        if (response.status === 429) {
          const retryAfter = response.headers["retry-after"];
          const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 10000;
          console.warn(`⚠️ Rate limited! Waiting ${waitTime}ms...`);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          continue;
        }

        if (response.status >= 400) {
          console.warn(`⚠️ API returned ${response.status}`);
          if (attempt < retries) {
            await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
            continue;
          }
          return null;
        }

        return response.data;
      } catch (error) {
        const axiosError = error as AxiosError;

        if (
          axiosError.code === "ECONNABORTED" ||
          axiosError.code === "ETIMEDOUT"
        ) {
          console.warn(`⏱️ Timeout (attempt ${attempt}/${retries})`);
        } else if (axiosError.response?.status === 429) {
          await new Promise((resolve) => setTimeout(resolve, 10000));
        } else {
          console.error(
            `❌ API error (attempt ${attempt}/${retries}):`,
            axiosError.message
          );
        }

        if (attempt < retries) {
          const backoff = 2000 * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }
    }

    this.consecutiveErrors++;
    return null;
  }

  private async checkAndRecaptureApiUrl(): Promise<boolean> {
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      console.warn(`⚠️ ${this.consecutiveErrors} errors, recapturing URL...`);
      this.apiUrl = null;
      const newUrl = await this.captureApiUrl(5, 3000);

      if (newUrl) {
        console.log("✅ API URL recaptured");
        this.consecutiveErrors = 0;
        return true;
      } else {
        console.error("❌ Failed to recapture API URL");
        return false;
      }
    }
    return true;
  }

  async startPolling(targetDate: Date, options: PollingOptions = {}) {
    const {
      interval = 3000,
      onExamFound,
      onExamWithOid,
      onTimeout,
      stopOnFirstOid = true,
      maxDurationMs = 30 * 60 * 1000,
      priorityLocations = ["chennai", "bengal", "bangalore"],
    } = options;

    this.shouldStopPolling = false;
    this.processingOid = false;
    this.processedOids.clear();
    this.consecutiveErrors = 0;

    if (!this.apiUrl) {
      console.log("🔡 Capturing API URL...");
      await this.captureApiUrl();

      if (!this.apiUrl) {
        console.error("❌ Could not capture API URL");
        if (onTimeout) await onTimeout();
        return;
      }
    }

    if (this.isPolling) {
      console.log("⚠️ Already polling, stopping previous");
      this.stopPolling();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const targetDateStr = targetDate.toISOString().split("T")[0];
    const targetTimeStr = targetDate.toTimeString().split(" ")[0];

    console.log(
      `🔡 Fast polling every ${
        interval / 1000
      }s for ${targetDateStr} at ${targetTimeStr}`
    );

    this.isPolling = true;

    this.timeoutInterval = setTimeout(async () => {
      console.log(`⏰ Max duration reached`);
      this.shouldStopPolling = true;
      if (onTimeout) {
        try {
          await onTimeout();
        } catch (error) {
          console.error("❌ Timeout callback error:", error);
        }
      }
      this.stopPolling();
    }, maxDurationMs);

    this.pollInterval = setInterval(async () => {
      if (this.shouldStopPolling) {
        console.log("🛑 Stopping poll");
        this.stopPolling();
        return;
      }

      if (this.processingOid) {
        console.log("⏭️ Skipping - processing OID");
        return;
      }

      const canContinue = await this.checkAndRecaptureApiUrl();
      if (!canContinue) {
        console.error("❌ Cannot continue polling");
        this.stopPolling();
        if (onTimeout) await onTimeout();
        return;
      }

      try {
        const data = await this.makeApiRequest(2);

        if (!data || !data.DATA || !Array.isArray(data.DATA)) {
          console.warn("⚠️ Invalid API response");
          return;
        }

        let matchingExams = data.DATA.filter((exam: ExamData) => {
          if (!exam.bookFromStamp) return false;

          const bookFromDate = new Date(exam.bookFromStamp);
          const bookFromDateStr = bookFromDate.toISOString().split("T")[0];
          const bookFromTimeStr = bookFromDate.toTimeString().split(" ")[0];

          const dateMatches = bookFromDateStr === targetDateStr;
          const timeMatches =
            bookFromTimeStr.substring(0, 5) === targetTimeStr.substring(0, 5);

          return dateMatches && timeMatches;
        });

        if (matchingExams.length > 0) {
          matchingExams = this.prioritizeExams(
            matchingExams,
            priorityLocations
          );
          const firstExam = matchingExams[0];

          console.log(`🎯 Found ${matchingExams.length} matching exam(s)`);

          for (const exam of matchingExams) {
            if (exam.oid && this.processedOids.has(exam.oid)) {
              console.log(
                `⏭️ Skipping processed OID: ${exam.oid.substring(0, 8)}...`
              );
              continue;
            }

            if (onExamFound && !exam.oid) {
              try {
                await onExamFound(exam);
              } catch (error) {
                console.error("❌ onExamFound error:", error);
              }
            }

            if (exam.oid) {
              console.log(
                `🚀 OID FOUND: ${exam.oid} at ${exam.locationName || "Unknown"}`
              );

              this.processedOids.add(exam.oid);

              if (onExamWithOid) {
                try {
                  this.processingOid = true;

                  if (stopOnFirstOid) {
                    this.shouldStopPolling = true;
                    this.stopPolling();
                  }

                  console.log(`⚡ IMMEDIATE PROCESSING: ${exam.oid}`);
                  await onExamWithOid(exam);

                  this.processingOid = false;

                  if (stopOnFirstOid) {
                    return;
                  }
                } catch (error) {
                  console.error("❌ onExamWithOid error:", error);
                  this.processingOid = false;
                }
              }

              if (stopOnFirstOid && !onExamWithOid) {
                this.shouldStopPolling = true;
                this.stopPolling();
                return;
              }
            } else {
              console.log(
                `⏳ Exam found (${
                  exam.eventName || "Unknown"
                }) - waiting for OID...`
              );
            }
          }
        }
      } catch (error: any) {
        console.error("❌ Polling error:", error.message);
        this.consecutiveErrors++;
      }
    }, interval);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.timeoutInterval) {
      clearTimeout(this.timeoutInterval);
      this.timeoutInterval = null;
    }

    if (this.isPolling) {
      this.isPolling = false;
      this.shouldStopPolling = true;
      console.log("🛑 Polling stopped");
    }
  }

  async forceStopPolling(maxWaitMs = 5000): Promise<void> {
    this.shouldStopPolling = true;
    this.stopPolling();

    const startTime = Date.now();
    while (this.processingOid && Date.now() - startTime < maxWaitMs) {
      console.log("⏳ Waiting for processing...");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  getApiUrl(): string | null {
    return this.apiUrl;
  }

  getStatus(): any {
    return {
      isPolling: this.isPolling,
      hasApiUrl: !!this.apiUrl,
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
