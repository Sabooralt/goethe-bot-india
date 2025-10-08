import Account from "../models/accountSchema";
import { instantBookingLauncher } from "../booking/book";
import { bot } from "..";
import Schedule, { ISchedule } from "../models/scheduleSchema";
import { UserDocument } from "../models/userSchema";
import dotenv from "dotenv";
import { browserPool, PrewarmedBrowser } from "../browsers/prewarmedBrowserPool";

dotenv.config();

interface DisplayInfo {
  display: string;
  displayNumber: string;
  noVncUrl: string;
  vncPort: number;
}

// OPTIMIZED: Ultra-fast parallel browser launcher
export const runAllAccountsWithPrewarmedBrowsers = async (
  oid: string,
  scheduleId?: string
) => {
  let schedule: ISchedule | null = null;
  let user: UserDocument | null = null;

  try {
    const startTime = Date.now();
    console.log(`⚡⚡⚡ ULTRA-FAST PARALLEL LAUNCH - OID: ${oid}`);

    if (scheduleId) {
      schedule = await Schedule.findById(scheduleId).populate("createdBy");
      if (schedule?.createdBy) {
        user = schedule.createdBy as any;
      }
    }

    // Get all ready browsers
    const readyBrowsers = browserPool.getAllReadyBrowsers();
    
    if (readyBrowsers.length === 0) {
      console.error("❌ No pre-warmed browsers ready!");
      
      if (scheduleId) {
        await Schedule.findByIdAndUpdate(scheduleId, {
          completed: true,
          status: "failed",
          lastRun: new Date(),
          lastError: "No pre-warmed browsers available",
        });
      }

      if (user?.telegramId && schedule) {
        await bot.sendMessage(
          user.telegramId,
          `❌ **Critical Error**\n` +
          `📋 Schedule: ${schedule.name}\n` +
          `🚨 No pre-warmed browsers ready!\n` +
          `💡 Browsers should have been pre-warmed during monitoring.`,
          { parse_mode: "Markdown" }
        );
      }
      
      return;
    }

    console.log(`🚀 Launching ${readyBrowsers.length} browsers SIMULTANEOUSLY!`);
    
    if (user?.telegramId && schedule) {
      await bot.sendMessage(
        user.telegramId,
        `⚡⚡⚡ **INSTANT MULTI-LAUNCH**\n` +
        `📋 Schedule: ${schedule.name}\n` +
        `🆔 OID: ${oid}\n` +
        `🔥 Browsers: ${readyBrowsers.length} ready\n` +
        `⚡ ALL BROWSERS LAUNCHING NOW!`,
        { parse_mode: "Markdown" }
      );
    }

    // CRITICAL OPTIMIZATION: Launch ALL browsers to the OID URL simultaneously
    const bookingUrl = `https://www.goethe.de/coe?lang=en&oid=${oid}`;
    
    // Create all navigation promises WITHOUT awaiting
    const navigationPromises = readyBrowsers.map((browser, index) => {
      const displayNumber = parseInt(browser.display.replace(":", ""));
      const displayInfo: DisplayInfo = {
        display: browser.display,
        displayNumber: browser.display.replace(":", ""),
        noVncUrl: `http://${process.env.SERVER_IP || "localhost"}:${6080 + displayNumber}/vnc.html`,
        vncPort: 5900 + displayNumber,
      };

      // CRITICAL: Direct navigation without wrapper - maximum speed
      const navPromise = browser.page.goto(bookingUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 300000
      });

      // Log navigation start (async, non-blocking)
      setImmediate(() => {
        console.log(`⚡ Browser ${index + 1}/${readyBrowsers.length} (${browser.accountEmail}) - LAUNCHED!`);
      });

      // Return promise that handles continuation after navigation
      return navPromise.then(async () => {
        const navTime = Date.now() - startTime;
        console.log(`✅ Browser ${index + 1} reached booking page in ${navTime}ms`);
        
        // Continue with booking process for this browser
        try {
          // Get the account object
          const account = await Account.findOne({ email: browser.accountEmail }).populate("user");
          if (!account) {
            console.error(`❌ Account not found for ${browser.accountEmail}`);
            return { success: false, email: browser.accountEmail, error: "Account not found" };
          }

          // Continue booking process
          await instantBookingLauncher(
            browser.page,
            account,
            oid,
            bot,
            displayInfo
          );

          return { success: true, email: browser.accountEmail };
        } catch (error) {
          console.error(`❌ Booking failed for ${browser.accountEmail}:`, error);
          return { success: false, email: browser.accountEmail, error: (error as Error).message };
        }
      }).catch(error => {
        console.error(`❌ Navigation failed for browser ${index + 1}:`, error);
        return { success: false, email: browser.accountEmail, error: (error as Error).message };
      });
    });

    // CRITICAL: Execute all navigations simultaneously - NO AWAIT HERE!
    console.log(`🏁 All ${navigationPromises.length} browsers launched in ${Date.now() - startTime}ms`);
    
    // Now wait for all to complete and collect results
    const results = await Promise.allSettled(navigationPromises);
    
    // Process results
    let successCount = 0;
    let errorCount = 0;
    
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const outcome = result.value as any;
        if (outcome?.success) {
          successCount++;
        } else {
          errorCount++;
        }
      } else {
        errorCount++;
        console.error(`Browser ${index + 1} promise rejected:`, result.reason);
      }
    });

    const totalTime = Date.now() - startTime;
    console.log(
      `✅ All browsers processed in ${totalTime}ms! Success: ${successCount}, Errors: ${errorCount}`
    );

    // Cleanup browsers after some delay to allow manual interaction
    setTimeout(async () => {
      await browserPool.closeAllBrowsers();
    }, 35 * 60 * 1000); // 35 minutes

    // Update schedule status
    if (scheduleId) {
      const isSuccess = errorCount === 0;

      await Schedule.findByIdAndUpdate(scheduleId, {
        completed: true,
        status: isSuccess ? "success" : "partial_success",
        lastRun: new Date(),
        lastError: isSuccess ? null : `${errorCount} accounts failed`,
      });
    }

    // Send final status
    if (user?.telegramId && schedule) {
      const statusIcon = errorCount === 0 ? "✅" : "⚠️";
      const statusText =
        errorCount === 0 ? "All Browsers Launched!" : "Launched with Some Errors";

      await bot.sendMessage(
        user.telegramId,
        `${statusIcon} **${statusText}**\n` +
        `📋 ${schedule.name}\n` +
        `⚡ Launch time: ${totalTime}ms\n` +
        `💥 Total: ${readyBrowsers.length}\n` +
        `✅ Success: ${successCount}\n` +
        `❌ Errors: ${errorCount}\n` +
        `🖥️ Browsers will stay open for 35 minutes`,
        { parse_mode: "Markdown" }
      );
    }

  } catch (error: any) {
    console.error("❌ Critical booking error:", error);
    
    // Don't close browsers immediately on error - leave them open for manual intervention
    setTimeout(async () => {
      await browserPool.closeAllBrowsers();
    }, 35 * 60 * 1000);

    if (scheduleId) {
      await Schedule.findByIdAndUpdate(scheduleId, {
        status: "failed",
        lastError: `System error: ${error.message}`,
        lastRun: new Date(),
      });
    }

    if (user?.telegramId && schedule) {
      await bot.sendMessage(
        user.telegramId,
        `❌ **Critical Error**\n` +
        `📋 ${schedule.name}\n` +
        `🚨 Error: ${error.message}`,
        { parse_mode: "Markdown" }
      );
    }

    throw error;
  }
};

// Alternative ultra-fast launcher that bypasses all account lookups
export const ultraFastDirectLaunch = async (oid: string): Promise<void> => {
  console.log(`🚀🚀🚀 ULTRA FAST DIRECT LAUNCH - NO OVERHEAD`);
  
  const browsers = browserPool.getAllReadyBrowsers();
  const bookingUrl = `https://www.goethe.de/coe?lang=en&oid=${oid}`;
  
  browsers.forEach((browser, i) => {
    browser.page.goto(bookingUrl, { waitUntil: 'domcontentloaded' })
      .then(() => console.log(`✅ Browser ${i + 1} loaded`))
      .catch(err => console.error(`❌ Browser ${i + 1} failed:`, err.message));
  });
  
  console.log(`⚡ Fired ${browsers.length} browsers instantly!`);
};