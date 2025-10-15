import puppeteer, { Browser, Page } from "puppeteer";
import { proxyPool, USE_PROXIES } from "../proxyPool";

interface PrewarmedBrowser {
  browser: Browser;
  page: Page;
  display: string;
  browserNumber: number;
  isReady: boolean;
  createdAt: Date;
  proxyUsed?: string;
}

const activeDisplays = new Set<string>();
const displayPool: string[] = Array.from({ length: 20 }, (_, i) => `:${i + 1}`);

class PrewarmedBrowserPool {
  private browsers: Map<number, PrewarmedBrowser> = new Map();
  private warmingUp: Set<number> = new Set();
  private displayAllocationLock = Promise.resolve();
  private preNavigated = false;

  private async allocateDisplay(): Promise<string | null> {
    return new Promise((resolve) => {
      this.displayAllocationLock = this.displayAllocationLock.then(async () => {
        for (const display of displayPool) {
          if (!activeDisplays.has(display)) {
            activeDisplays.add(display);
            console.log(
              `📺 Allocated ${display} (${activeDisplays.size}/${displayPool.length})`
            );
            resolve(display);
            return;
          }
        }
        console.warn(`⚠️ All displays busy`);
        resolve(null);
      });
    });
  }

  private releaseDisplay(display: string): void {
    if (activeDisplays.has(display)) {
      activeDisplays.delete(display);
      console.log(`♻️ Released ${display}`);
    }
  }

  private async prewarmBrowser(
    browserNumber: number,
    display: string
  ): Promise<PrewarmedBrowser | null> {
    try {
      console.log(`🔥 Pre-warming browser ${browserNumber} on ${display}...`);

      let proxy: any = null;
      let proxyUrl = "";
      if (USE_PROXIES) {
        proxy = proxyPool.getNextProxy();
        if (proxy) {
          proxyUrl = `${proxy.host}:${proxy.port}`;
          console.log(`🔒 Proxy ${proxyUrl} → Browser ${browserNumber}`);
        }
      }

      const browserArgs = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-web-security",
        "--disable-features=VizDisplayCompositor",
        `--display=${display}`,
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-features=TranslateUI",
        "--disable-ipc-flooding-protection",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-default-apps",
        "--disable-background-networking",
        "--disable-breakpad",
        "--disable-client-side-phishing-detection",
        "--disable-component-extensions-with-background-pages",
        "--disable-domain-reliability",
        "--disable-features=AutofillServerCommunication",
        "--disable-sync",
        "--enable-features=NetworkService,NetworkServiceInProcess",
        "--force-color-profile=srgb",
        "--metrics-recording-only",
        "--mute-audio",
        "--disable-blink-features=AutomationControlled",
        "--disable-logging",
        "--disable-permissions-api",
        "--disable-save-password-bubble",
        "--disable-single-click-autofill",
        "--disable-extensions",
        "--disable-popup-blocking",
        "--disable-prompt-on-repost",
        "--aggressive-cache-discard",
        "--aggressive-tab-discard",
        "--disable-component-update",
        "--disable-field-trial-config",
        "--disable-background-media-suspend",
      ];

      if (proxy) {
        browserArgs.push(
          `--proxy-server=${proxy.type}://${proxy.host}:${proxy.port}`
        );
      }

      const browser = await puppeteer.launch({
        headless: false,
        executablePath: "/usr/bin/chromium-browser",
        env: {
          DISPLAY: display,
          CHROME_DEVEL_SANDBOX: "/usr/local/sbin/chrome-devel-sandbox",
          XAUTHORITY: process.env.XAUTHORITY || "/tmp/.docker.xauth",
          HOME: process.env.HOME || "/tmp",
        },
        args: browserArgs,
        timeout: 30000,
        protocolTimeout: 180000,
      });

      const page = await browser.newPage();

      if (proxy && proxy.username && proxy.password) {
        await page.authenticate({
          username: proxy.username,
          password: proxy.password,
        });
      }

      await page.setDefaultNavigationTimeout(180000);
      await page.setDefaultTimeout(180000);

      // Minimal request interception for speed
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const resourceType = req.resourceType();
        // Only block heavy resources
        if (resourceType === "image" || resourceType === "media" || resourceType === "font") {
          req.abort();
        } else {
          req.continue();
        }
      });

      // Set cookies and storage
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem(
          "uc_gcm",
          JSON.stringify({
            adsDataRedaction: true,
            adPersonalization: "denied",
            adStorage: "denied",
            adUserData: "denied",
            analyticsStorage: "denied",
          })
        );
        localStorage.setItem("uc_ui_version", "3.73.0");
        localStorage.setItem("uc_user_interaction", "true");
        localStorage.setItem(
          "uc_settings",
          JSON.stringify({
            controllerId:
              "42e213448633d19d017343f77368ef4ab462b0ca1fb10607c313393260b08f21",
            id: "rTbKQ4Qc-",
            services: [],
          })
        );
      });

      console.log(`✅ Pre-warmed browser ${browserNumber}`);

      return {
        browser,
        page,
        display,
        browserNumber,
        isReady: true,
        createdAt: new Date(),
        proxyUsed: proxyUrl,
      };
    } catch (error) {
      console.error(`❌ Pre-warm failed browser ${browserNumber}:`, error);
      this.releaseDisplay(display);
      return null;
    }
  }

  // Pre-navigate browsers to Goethe domain for faster connection
  async preNavigateBrowsers(): Promise<void> {
    if (this.preNavigated) return;
    
    const browsers = this.getAllReadyBrowsers();
    
    console.log(`🌐 Pre-navigating ${browsers.length} browsers to goethe.de...`);
    
    const navPromises = browsers.map(async (browser) => {
      try {
        // Pre-establish connection to Goethe domain
        await browser.page.goto('https://www.goethe.de/', {
          waitUntil: 'domcontentloaded',
          timeout: 10000
        });
        console.log(`✅ Pre-navigated browser ${browser.browserNumber}`);
        return true;
      } catch (error) {
        console.warn(`⚠️ Pre-navigation failed for browser ${browser.browserNumber}`);
        return false;
      }
    });
    
    const results = await Promise.allSettled(navPromises);
    const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
    
    console.log(`🌐 Pre-navigation complete: ${successful}/${browsers.length} successful`);
    this.preNavigated = true;
  }

  // MODIFIED: Warm exactly 20 browsers (no user/account dependency)
  async warmup20Browsers(): Promise<void> {
    try {
      console.log(`🔥 Warming up 20 browsers...`);

      // Warm 20 browsers in parallel
      const warmupPromises = [];
      
      for (let i = 1; i <= 20; i++) {
        if (this.warmingUp.has(i) || this.browsers.has(i)) {
          continue;
        }

        this.warmingUp.add(i);

        const warmupPromise = (async (browserNumber: number) => {
          try {
            const display = await this.allocateDisplay();
            if (!display) {
              console.warn(`⚠️ No display for browser ${browserNumber}`);
              this.warmingUp.delete(browserNumber);
              return;
            }

            const prewarmed = await this.prewarmBrowser(browserNumber, display);

            if (prewarmed) {
              this.browsers.set(browserNumber, prewarmed);
              console.log(
                `✅ Browser ${browserNumber} warmed (${this.browsers.size}/20)`
              );
            } else {
              this.releaseDisplay(display);
            }
          } catch (error) {
            console.error(`❌ Browser ${browserNumber} warmup failed:`, error);
          } finally {
            this.warmingUp.delete(browserNumber);
          }
        })(i);

        warmupPromises.push(warmupPromise);
      }

      await Promise.all(warmupPromises);

      console.log(
        `🎉 Warming complete! ${this.browsers.size}/20 ready`
      );
      
      // Pre-navigate all browsers after warming
      await this.preNavigateBrowsers();
      
    } catch (error) {
      console.error(`❌ Warmup error:`, error);
    }
  }

  // Get all ready browsers for simultaneous launch
  getAllReadyBrowsers(): PrewarmedBrowser[] {
    return Array.from(this.browsers.values()).filter(b => b.isReady);
  }

  getPrewarmedBrowser(browserNumber: number): PrewarmedBrowser | null {
    const browser = this.browsers.get(browserNumber);

    if (browser && browser.isReady) {
      console.log(`⚡ INSTANT: Got pre-warmed browser ${browserNumber}`);
      return browser;
    }

    return null;
  }

  removeBrowser(browserNumber: number): void {
    this.browsers.delete(browserNumber);
  }

  async closeBrowser(browserNumber: number): Promise<void> {
    const browser = this.browsers.get(browserNumber);

    if (browser) {
      try {
        await browser.browser.close();
        this.releaseDisplay(browser.display);
        this.browsers.delete(browserNumber);
        console.log(`🔄 Closed browser ${browserNumber}`);
      } catch (error) {
        console.error(`❌ Close error browser ${browserNumber}:`, error);
      }
    }
  }

  async closeAllBrowsers(): Promise<void> {
    console.log(`🔄 Closing ${this.browsers.size} browsers...`);

    const closePromises = Array.from(this.browsers.keys()).map((num) =>
      this.closeBrowser(num)
    );

    await Promise.allSettled(closePromises);

    this.browsers.clear();
    activeDisplays.clear();
    this.preNavigated = false;

    console.log(`✅ All browsers closed`);
  }

  getStatus(): any {
    return {
      totalBrowsers: this.browsers.size,
      readyBrowsers: Array.from(this.browsers.values()).filter((b) => b.isReady)
        .length,
      warmingBrowsers: this.warmingUp.size,
      displays: Array.from(this.browsers.values()).map((b) => b.display),
      browserNumbers: Array.from(this.browsers.keys()),
      preNavigated: this.preNavigated,
    };
  }

  allBrowsersReady(): boolean {
    return this.warmingUp.size === 0 && this.browsers.size > 0;
  }

  getReadyCount(): number {
    return this.browsers.size;
  }
}

export const browserPool = new PrewarmedBrowserPool();
export { PrewarmedBrowserPool, PrewarmedBrowser };