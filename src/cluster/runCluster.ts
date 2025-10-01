import puppeteer, { Browser, Page } from "puppeteer";
import Account from "../models/accountSchema";
import startBooking from "../booking/book";
import { bot } from "..";
import Schedule, { ISchedule } from "../models/scheduleSchema";
import { UserDocument } from "../models/userSchema";
import dotenv from "dotenv";

dotenv.config();

interface BrowserInstance {
  browser: Browser;
  page: Page;
  display: string;
  accountEmail: string;
}

interface ScheduleManager {
  browsers: BrowserInstance[];
  isRunning: boolean;
  shouldStop: boolean;
  processedCount: number;
  successCount: number;
  errorCount: number;
}

// Global display management - using only 10 pre-created displays
const activeSchedules: Map<string, ScheduleManager> = new Map();
const activeDisplays = new Set<string>();
const displayPool: string[] = Array.from(
  { length: 10 },
  (_, i) => `:${i + 10}`
); // :1 to :10

// Mutex for display allocation
let displayAllocationLock = Promise.resolve();

/**
 * Allocate an available display with thread-safe locking
 * Displays are pre-created and always running, we just track which are in use
 */
async function allocateDisplay(): Promise<string | null> {
  return new Promise((resolve) => {
    displayAllocationLock = displayAllocationLock.then(async () => {
      for (const display of displayPool) {
        if (!activeDisplays.has(display)) {
          activeDisplays.add(display);
          console.log(
            `📺 Allocated display ${display} (${activeDisplays.size}/${displayPool.length} in use)`
          );
          resolve(display);
          return;
        }
      }
      console.warn(`⚠️ All ${displayPool.length} displays are in use!`);
      resolve(null);
    });
  });
}

/**
 * Release a display back to the pool
 * Display keeps running, just marked as available
 */
function releaseDisplay(display: string): void {
  if (activeDisplays.has(display)) {
    activeDisplays.delete(display);
    console.log(
      `♻️ Released display ${display} (${activeDisplays.size}/${displayPool.length} in use)`
    );
  }
}

/**
 * Wait for an available display with exponential backoff
 * This is useful when all displays are busy
 */
async function waitForAvailableDisplay(
  maxRetries = 10
): Promise<string | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const display = await allocateDisplay();
    if (display) {
      return display;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s... up to 30s
    const waitTime = Math.min(1000 * Math.pow(2, attempt), 30000);
    console.log(
      `⏳ All displays busy, waiting ${
        waitTime / 1000
      }s before retry (attempt ${attempt + 1}/${maxRetries})`
    );
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  return null;
}

/**
 * Create browser instance with better error handling
 * Connects to pre-existing display
 */
async function createBrowserInstance(
  account: any,
  display: string,
  retries = 3
): Promise<BrowserInstance | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(
        `🌐 Creating browser for ${account.email} on display ${display} (attempt ${attempt}/${retries})...`
      );

      const browser = await puppeteer.launch({
        headless: false,
        executablePath: "/usr/bin/chromium-browser",
        env: {
          DISPLAY: display,
          // Ensure we're not trying to use sandbox in Docker/restricted environments
          CHROME_DEVEL_SANDBOX: "/usr/local/sbin/chrome-devel-sandbox",
        },
        args: [
          // Performance optimizations
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

          // Skip first run tasks
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-default-apps",

          // Disable telemetry and unnecessary network calls
          "--disable-background-networking",
          "--disable-breakpad",
          "--disable-client-side-phishing-detection",
          "--disable-component-extensions-with-background-pages",
          "--disable-domain-reliability",
          "--disable-features=AutofillServerCommunication",
          "--disable-sync",

          // Performance flags
          "--enable-features=NetworkService,NetworkServiceInProcess",
          "--force-color-profile=srgb",
          "--metrics-recording-only",
          "--mute-audio",

          // Memory optimization
          "--max_old_space_size=512",
          "--memory-pressure-off",

          // Additional speed optimizations
          "--disable-blink-features=AutomationControlled",
          "--disable-logging",
          "--disable-permissions-api",
          "--disable-save-password-bubble",
          "--disable-single-click-autofill",
          "--disable-extensions",
          "--disable-popup-blocking",
          "--disable-prompt-on-repost",
        ],
        // Timeout configurations
        timeout: 18000000,
        protocolTimeout: 18000000,
      });

      const page = await browser.newPage();

      /*  await page.authenticate({
         username: "fqzswucp-rotate",
         password: "jonjzja5h9aa",     
       }); */

      // Performance optimizations for the page
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setDefaultNavigationTimeout(18000000);
      await page.setDefaultTimeout(18000000);

      // Disable unnecessary features for speed

      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const resourceType = req.resourceType();
        if (
          resourceType === "image" ||
          resourceType === "font" ||
          resourceType === "media" ||
          resourceType === "other"
        ) {
          req.abort();
        } else {
          req.continue();
        }
      });

      // Test that browser is working
      await page.goto("about:blank");

      console.log(`✅ Browser created for ${account.email} on ${display}`);

      return {
        browser,
        page,
        display,
        accountEmail: account.email,
      };
    } catch (error) {
      console.error(
        `❌ Failed to create browser for ${account.email} (attempt ${attempt}/${retries}):`,
        error
      );

      if (attempt === retries) {
        console.error(`❌ All attempts failed for ${account.email}`);
        return null;
      }

      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  return null;
}

/**
 * Close browser instance safely
 */
async function closeBrowserInstance(
  browserInstance: BrowserInstance
): Promise<void> {
  try {
    console.log(`🔄 Closing browser for ${browserInstance.accountEmail}...`);

    // Set a timeout for browser close operation
    await Promise.race([
      browserInstance.browser.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Browser close timeout")), 5000)
      ),
    ]);

    console.log(`✅ Browser closed for ${browserInstance.accountEmail}`);
  } catch (error) {
    console.error(
      `⚠️ Error closing browser for ${browserInstance.accountEmail}:`,
      error
    );

    // Force kill if normal close fails
    try {
      const pages = await browserInstance.browser.pages();
      await Promise.all(pages.map((page) => page.close().catch(() => {})));
      await browserInstance.browser.close().catch(() => {});
    } catch {
      // Ignore errors in force close
    }
  }
}

/**
 * Process a single account with proper error handling
 */
async function processAccount(
  account: any,
  oid: string,
  scheduleManager: ScheduleManager,
  schedule: ISchedule | null,
  user: UserDocument | null
): Promise<void> {
  let browserInstance: BrowserInstance | null = null;
  let display: string | null = null;

  try {
    // Check if schedule should stop before processing
    if (scheduleManager.shouldStop) {
      console.log(`⏹️ Skipping ${account.email} - schedule marked for stop`);
      return;
    }

    // Wait for an available display (with retry logic)
    display = await waitForAvailableDisplay();
    if (!display) {
      throw new Error("No display available after maximum retries");
    }

    // Create browser instance with retries
    browserInstance = await createBrowserInstance(account, display);

    if (!browserInstance) {
      throw new Error("Failed to create browser after all retries");
    }

    scheduleManager.browsers.push(browserInstance);

    console.log(`🔄 Processing ${account.email} on display ${display}`);

    // Process the account booking
    const displayNumber = parseInt(display.replace(":", ""));
    const displayInfo = {
      display: display,
      displayNumber: display.replace(":", ""),
      noVncUrl: `http://${process.env.SERVER_IP || "localhost"}:${
        6080 + displayNumber
      }/vnc.html`,
      vncPort: 5900 + displayNumber,
    };

    console.log(
      `📺 Account ${account.email} browser accessible at: ${displayInfo.noVncUrl}`
    );

    // Add timeout for booking process
    const bookingTimeout = 5 * 60 * 60 * 1000;
    await Promise.race([
      startBooking(browserInstance.page, account, oid, bot, displayInfo),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Booking timeout")), bookingTimeout)
      ),
    ]);

    scheduleManager.processedCount++;
    scheduleManager.successCount++;

    console.log(`✅ Account ${account.email} processed successfully`);

    // Send periodic updates
    const totalAccounts =
      scheduleManager.processedCount +
      (scheduleManager.browsers.length - scheduleManager.processedCount);

    if (
      scheduleManager.processedCount % 2 === 0 ||
      scheduleManager.processedCount === totalAccounts
    ) {
      if (user?.telegramId && schedule) {
        await bot.sendMessage(
          user.telegramId,
          `📊 **Progress Update**\n` +
            `📝 Schedule: ${schedule.name}\n` +
            `✅ Processed: ${scheduleManager.processedCount}/${totalAccounts}\n` +
            `🎯 Successful: ${scheduleManager.successCount}\n` +
            `❌ Errors: ${scheduleManager.errorCount}`,
          { parse_mode: "Markdown" }
        );
      }
    }
  } catch (accountError) {
    scheduleManager.processedCount++;
    scheduleManager.errorCount++;

    console.error(`❌ Account ${account.email} failed:`, accountError);

    // Send error notification to account owner
    if (account.user?.telegramId) {
      await bot.sendMessage(
        account.user.telegramId,
        `❌ **Account Error**\n` +
          `📧 Account: ${account.email}\n` +
          `🚨 Error: ${(accountError as Error).message}\n` +
          `⏰ Time: ${new Date().toLocaleString()}`,
        { parse_mode: "Markdown" }
      );
    }

    // Also send to schedule owner if different
    if (
      user?.telegramId &&
      user.telegramId !== account.user?.telegramId &&
      schedule
    ) {
      await bot.sendMessage(
        user.telegramId,
        `⚠️ **Account Error in Schedule**\n` +
          `📝 Schedule: ${schedule.name}\n` +
          `📧 Account: ${account.email}\n` +
          `❌ Error: ${(accountError as Error).message}`,
        { parse_mode: "Markdown" }
      );
    }

    throw accountError;
  } finally {
    // Clean up resources
    if (browserInstance) {
      await closeBrowserInstance(browserInstance);
      // Remove from active browsers list
      const index = scheduleManager.browsers.findIndex(
        (b) => b === browserInstance
      );
      if (index > -1) {
        scheduleManager.browsers.splice(index, 1);
      }
    }

    // Always release the display back to the pool
    if (display) {
      releaseDisplay(display);
    }
  }
}

export const runAllAccounts = async (oid: string, scheduleId?: string) => {
  let schedule: ISchedule | null = null;
  let user: UserDocument | null = null;
  let scheduleManager: ScheduleManager | null = null;

  try {
    console.log("🚀 Starting individual browser automation...");
    console.log(`📊 Display pool: ${displayPool.length} displays available`);

    // Get schedule and user info for logging
    if (scheduleId) {
      schedule = await Schedule.findById(scheduleId).populate("createdBy");
      if (schedule?.createdBy) {
        user = schedule.createdBy as any;
      }
    }

    // Initialize schedule manager
    scheduleManager = {
      browsers: [],
      isRunning: true,
      shouldStop: false,
      processedCount: 0,
      successCount: 0,
      errorCount: 0,
    };

    if (scheduleId) {
      activeSchedules.set(scheduleId, scheduleManager);
    }

    // Send initial log to user
    if (user?.telegramId && schedule) {
      await bot.sendMessage(
        user.telegramId,
        `🚀 **Automation Started**\n` +
          `📝 Schedule: ${schedule.name}\n` +
          `🆔 OID: ${oid}\n` +
          `📺 Display pool: ${displayPool.length} displays\n` +
          `⚡ Initializing browsers...`,
        { parse_mode: "Markdown" }
      );
    }

    // Get all active accounts
    const accounts = await Account.find({ status: true }).populate("user");

    if (!accounts || accounts.length === 0) {
      console.log("ℹ️ No active accounts found. Exiting...");

      const errorMsg = "No active accounts found";

      // Update schedule status if applicable
      if (scheduleId) {
        await Schedule.findByIdAndUpdate(scheduleId, {
          completed: true,
          status: "failed",
          lastRun: new Date(),
          lastError: errorMsg,
        });
      }

      // Send notification to user
      if (user?.telegramId && schedule) {
        await bot.sendMessage(
          user.telegramId,
          `❌ **Schedule Failed**\n` +
            `📝 Schedule: ${schedule.name}\n` +
            `🚨 Error: ${errorMsg}\n` +
            `💡 Please add active accounts and try again.`,
          { parse_mode: "Markdown" }
        );
      }

      return;
    }

    // Send progress update to user
    if (user?.telegramId && schedule) {
      await bot.sendMessage(
        user.telegramId,
        `🔄 **Processing Accounts**\n` +
          `📝 Schedule: ${schedule.name}\n` +
          `👥 Found ${accounts.length} active accounts\n` +
          `⚡ Starting booking process...`,
        { parse_mode: "Markdown" }
      );
    }

    console.log(`📊 Processing ${accounts.length} accounts...`);

    // Determine optimal concurrency based on available displays
    // We can run up to 10 concurrent browsers (one per display)
    const maxConcurrent = Math.min(10, accounts.length);
    console.log(`⚡ Running with ${maxConcurrent} concurrent browsers`);

    const accountQueue = [...accounts];
    const activePromises: Promise<void>[] = [];

    while (accountQueue.length > 0 || activePromises.length > 0) {
      // Check if schedule should stop
      if (scheduleManager.shouldStop) {
        console.log("⏹️ Schedule stop requested, breaking processing loop");
        break;
      }

      // Start new accounts if we have space and accounts to process
      while (activePromises.length < maxConcurrent && accountQueue.length > 0) {
        const account = accountQueue.shift()!;

        const accountPromise = processAccount(
          account,
          oid,
          scheduleManager,
          schedule,
          user
        ).catch((error) => {
          // Error handling is already done in processAccount
          console.error(`Account ${account.email} processing failed:`, error);
        });

        activePromises.push(accountPromise);
      }

      // Wait for at least one account to complete
      if (activePromises.length > 0) {
        await Promise.race(activePromises);

        // Remove completed promises
        for (let i = activePromises.length - 1; i >= 0; i--) {
          const promise = activePromises[i];
          // Check if promise is resolved
          try {
            await Promise.race([
              promise,
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("timeout")), 0)
              ),
            ]);
            // If we get here, the promise resolved
            activePromises.splice(i, 1);
          } catch (error: any) {
            if (error.message !== "timeout") {
              // Promise rejected
              activePromises.splice(i, 1);
            }
          }
        }
      }
    }

    // Wait for all remaining promises to complete
    await Promise.allSettled(activePromises);

    console.log("✅ All accounts processed!");
    console.log(
      `📊 Final stats: ${scheduleManager.successCount} successful, ${scheduleManager.errorCount} errors out of ${accounts.length} total`
    );

    // Update schedule status if applicable
    if (scheduleId) {
      const isSuccess = scheduleManager.errorCount === 0;
      const wasStopped = scheduleManager.shouldStop;

      await Schedule.findByIdAndUpdate(scheduleId, {
        completed: true,
        status: wasStopped
          ? "stopped"
          : isSuccess
          ? "success"
          : "partial_success",
        lastRun: new Date(),
        lastError: wasStopped
          ? "Schedule stopped by user request"
          : isSuccess
          ? null
          : `${scheduleManager.errorCount} accounts failed out of ${accounts.length}`,
      });

      // Send final notification
      if (user?.telegramId && schedule) {
        const statusIcon = wasStopped ? "⏹️" : isSuccess ? "✅" : "⚠️";
        const statusText = wasStopped
          ? "Stopped by User"
          : isSuccess
          ? "Completed Successfully"
          : "Completed with Errors";

        await bot.sendMessage(
          user.telegramId,
          `${statusIcon} **Schedule ${statusText}**\n` +
            `📝 Schedule: ${schedule.name}\n` +
            `👥 Total accounts: ${accounts.length}\n` +
            `✅ Successful: ${scheduleManager.successCount}\n` +
            `❌ Errors: ${scheduleManager.errorCount}\n` +
            `⏰ Completed at: ${new Date().toLocaleString()}\n\n` +
            (wasStopped
              ? `⏹️ Schedule was stopped by user request.`
              : isSuccess
              ? `🎉 All accounts processed successfully!`
              : `⚠️ Some accounts encountered errors. Check individual account notifications for details.`),
          { parse_mode: "Markdown" }
        );
      }
    }
  } catch (error) {
    console.error("❌ Automation error:", error);
    const errorMessage = (error as any).message || (error as string).toString();

    // Update schedule status if applicable
    if (scheduleId) {
      await Schedule.findByIdAndUpdate(scheduleId, {
        status: "failed",
        lastError: `System error: ${errorMessage}`,
        lastRun: new Date(),
      });
    }

    // Send error notification
    if (user?.telegramId && schedule) {
      await bot.sendMessage(
        user.telegramId,
        `❌ **Schedule Failed**\n` +
          `📝 Schedule: ${schedule.name}\n` +
          `🚨 System Error: ${errorMessage}\n` +
          `⏰ Failed at: ${new Date().toLocaleString()}\n\n` +
          `💡 This appears to be a system error. Please try again or contact support.`,
        { parse_mode: "Markdown" }
      );
    }

    throw error;
  } finally {
    // Cleanup: close any remaining browsers
    if (scheduleManager) {
      scheduleManager.isRunning = false;

      if (scheduleManager.browsers.length > 0) {
        console.log(
          `🧹 Cleaning up ${scheduleManager.browsers.length} remaining browsers...`
        );

        const closePromises = scheduleManager.browsers.map((browserInstance) =>
          closeBrowserInstance(browserInstance)
        );

        await Promise.allSettled(closePromises);
        scheduleManager.browsers = [];
      }

      // Remove from active schedules
      if (scheduleId) {
        activeSchedules.delete(scheduleId);
      }
    }

    // Release any remaining allocated displays
    console.log(`♻️ Releasing ${activeDisplays.size} allocated displays...`);
    activeDisplays.clear();
  }
};

// Enhanced function to stop a running schedule
export const stopSchedule = async (scheduleId: string): Promise<boolean> => {
  const scheduleManager = activeSchedules.get(scheduleId);

  if (scheduleManager) {
    try {
      console.log(`🛑 Stopping schedule ${scheduleId}...`);

      // Get schedule info for notification
      const schedule = await Schedule.findById(scheduleId).populate(
        "createdBy"
      );

      // Mark for stopping
      scheduleManager.shouldStop = true;

      // Close all active browsers
      if (scheduleManager.browsers.length > 0) {
        console.log(
          `🧹 Closing ${scheduleManager.browsers.length} active browsers...`
        );

        const closePromises = scheduleManager.browsers.map(
          async (browserInstance) => {
            // Release display before closing browser
            releaseDisplay(browserInstance.display);
            await closeBrowserInstance(browserInstance);
          }
        );

        await Promise.allSettled(closePromises);
        scheduleManager.browsers = [];
      }

      // Update schedule status
      await Schedule.findByIdAndUpdate(scheduleId, {
        status: "stopped",
        lastError: "Schedule stopped by user request",
        lastRun: new Date(),
      });

      // Notify user
      if (schedule?.createdBy) {
        const user = schedule.createdBy as any;
        if (user.telegramId) {
          await bot.sendMessage(
            user.telegramId,
            `🛑 **Schedule Stopped**\n` +
              `📝 Schedule: ${schedule.name}\n` +
              `⚠️ Booking process was stopped by request\n` +
              `⏰ Stopped at: ${new Date().toLocaleString()}`,
            { parse_mode: "Markdown" }
          );
        }
      }

      // Remove from active schedules
      activeSchedules.delete(scheduleId);

      console.log(`✅ Successfully stopped schedule ${scheduleId}`);
      return true;
    } catch (error) {
      console.error(`❌ Error stopping schedule ${scheduleId}:`, error);
      return false;
    }
  } else {
    console.log(`⚠️ No active schedule found for ${scheduleId}`);
    return false;
  }
};

// Get status of all active schedules
export const getScheduleStatus = (): {
  activeSchedules: string[];
  totalActive: number;
  displayPoolStatus: {
    total: number;
    active: number;
    available: number;
  };
  scheduleDetails: Array<{
    scheduleId: string;
    activeBrowsers: number;
    processedCount: number;
    successCount: number;
    errorCount: number;
    isRunning: boolean;
  }>;
} => {
  const scheduleDetails = Array.from(activeSchedules.entries()).map(
    ([scheduleId, manager]) => ({
      scheduleId,
      activeBrowsers: manager.browsers.length,
      processedCount: manager.processedCount,
      successCount: manager.successCount,
      errorCount: manager.errorCount,
      isRunning: manager.isRunning,
    })
  );

  return {
    activeSchedules: Array.from(activeSchedules.keys()),
    totalActive: activeSchedules.size,
    displayPoolStatus: {
      total: displayPool.length,
      active: activeDisplays.size,
      available: displayPool.length - activeDisplays.size,
    },
    scheduleDetails,
  };
};

// Emergency stop all schedules
export const stopAllSchedules = async (): Promise<void> => {
  console.log(
    `🛑 Emergency stop: Stopping ${activeSchedules.size} active schedules...`
  );

  const stopPromises = Array.from(activeSchedules.keys()).map((scheduleId) =>
    stopSchedule(scheduleId)
  );

  await Promise.allSettled(stopPromises);

  // Clear all display allocations
  activeDisplays.clear();

  console.log("✅ All schedules stopped and displays released");
};

// Get browsers for a specific schedule (useful for monitoring)
export const getScheduleBrowsers = (scheduleId: string): BrowserInstance[] => {
  const scheduleManager = activeSchedules.get(scheduleId);
  return scheduleManager ? scheduleManager.browsers : [];
};

// Force close a specific browser instance
export const closeBrowser = async (
  scheduleId: string,
  accountEmail: string
): Promise<boolean> => {
  const scheduleManager = activeSchedules.get(scheduleId);

  if (scheduleManager) {
    const browserInstance = scheduleManager.browsers.find(
      (b) => b.accountEmail === accountEmail
    );

    if (browserInstance) {
      // Release display before closing
      releaseDisplay(browserInstance.display);

      await closeBrowserInstance(browserInstance);

      // Remove from browsers array
      const index = scheduleManager.browsers.indexOf(browserInstance);
      if (index > -1) {
        scheduleManager.browsers.splice(index, 1);
      }

      return true;
    }
  }

  return false;
};

// Get display pool status (for monitoring)
export const getDisplayPoolStatus = (): {
  totalDisplays: number;
  activeDisplays: number;
  availableDisplays: number;
  utilizationPercentage: number;
  displayList: {
    active: string[];
    available: string[];
  };
} => {
  const availableDisplaysList = displayPool.filter(
    (d) => !activeDisplays.has(d)
  );
  const utilizationPercentage =
    (activeDisplays.size / displayPool.length) * 100;

  return {
    totalDisplays: displayPool.length,
    activeDisplays: activeDisplays.size,
    availableDisplays: availableDisplaysList.length,
    utilizationPercentage: Math.round(utilizationPercentage),
    displayList: {
      active: Array.from(activeDisplays),
      available: availableDisplaysList,
    },
  };
};

// Check if system can handle more accounts
export const canProcessMoreAccounts = (): boolean => {
  return activeDisplays.size < displayPool.length;
};

// Get estimated wait time for next available display
export const getEstimatedWaitTime = (): {
  canProcess: boolean;
  estimatedWaitSeconds: number;
} => {
  const available = displayPool.length - activeDisplays.size;

  if (available > 0) {
    return { canProcess: true, estimatedWaitSeconds: 0 };
  }

  // Estimate based on average processing time (adjust based on your metrics)
  const avgProcessingTimeSeconds = 60; // Adjust based on your actual metrics

  return {
    canProcess: false,
    estimatedWaitSeconds: avgProcessingTimeSeconds,
  };
};
