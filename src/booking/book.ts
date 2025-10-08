import { Page } from "puppeteer";
import dotenv from "dotenv";
import type TelegramBot from "node-telegram-bot-api";
import { handleBookingConflict } from "../fillers/handleBookingConflict";
import { AccountDocument } from "../models/accountSchema";
import { UserDocument } from "../models/userSchema";
import { selectAvailableModules } from "../fillers/selectAllModules";

dotenv.config();

interface DisplayInfo {
  display: string;
  displayNumber: string;
  noVncUrl: string;
  vncPort: number;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const sendAccountLog = (
  bot: TelegramBot,
  chatId: string,
  account: AccountDocument,
  message: string
) => {
  const accountInfo = `[${account.email}]`;
  const fullMessage = `${accountInfo} ${message}`;

  // Fire and forget - don't block on telegram messages
  setImmediate(() => {
    try {
      bot.sendMessage(chatId, fullMessage, { parse_mode: "Markdown" });
      console.log(fullMessage);
    } catch (error) {
      console.error("Failed to send Telegram message:", error);
    }
  });
};

/**
 * Helper to send error message with browser access info and wait for manual intervention
 */
const handleErrorWithBrowserAccess = async (
  bot: TelegramBot,
  chatId: string,
  acc: AccountDocument,
  errorMessage: string,
  displayInfo?: DisplayInfo,
  waitTime: number = 1800000 // 30 minutes default
) => {
  let message = `❌ ${errorMessage}\n\n`;

  if (displayInfo) {
    message +=
      `🖥️ **Manual Access Available:**\n` +
      `🔗 **noVNC URL:** ${displayInfo.noVncUrl}\n` +
      `🖥️ **Display:** ${displayInfo.display}\n` +
      `🔌 **VNC Port:** ${displayInfo.vncPort}\n\n` +
      `💡 You can manually complete the booking process.\n` +
      `⏳ Browser will stay open for ${waitTime / 60000} minutes.`;
  } else {
    message += `🖥️ Please access the RDP to complete the booking manually.`;
  }

  sendAccountLog(bot, chatId, acc, message);

  // Wait for manual intervention
  await delay(waitTime);
};

// OPTIMIZED: Instant booking launcher - fires navigation immediately
const instantBookingLauncher = async (
  page: Page,
  acc: AccountDocument,
  oid: string,
  bot: TelegramBot,
  displayInfo?: DisplayInfo
) => {
  const chatId = (acc.user as UserDocument).telegramId;
  const bookingUrl = `https://www.goethe.de/coe?lang=en&oid=${oid}`;
  
  console.log(`⚡ INSTANT LAUNCH for ${acc.email}: ${bookingUrl}`);
  
  // CRITICAL: Navigate IMMEDIATELY - no checks, no delays
  // Fire and forget navigation - don't await
  const navigationPromise = page.goto(bookingUrl, {
    waitUntil: "domcontentloaded",
    timeout: 300000
  });

  // Send notification async - don't block
  sendAccountLog(bot, chatId, acc, `⚡ INSTANT LAUNCH - Opening booking page with OID: ${oid}`);

  // Wait for navigation and continue booking
  try {
    await navigationPromise;
    console.log(`✅ Page loaded for ${acc.email}`);
    
    // Continue with the rest of the booking process
    await continueBookingProcess(page, acc, oid, bot, displayInfo);
  } catch (error) {
    console.error(`Failed to load page for ${acc.email}:`, error);
    await handleErrorWithBrowserAccess(
      bot,
      chatId,
      acc,
      `Failed to load booking page: ${(error as Error).message}`,
      displayInfo,
      1800000
    );
  }
};

// Separated booking continuation logic
const continueBookingProcess = async (
  page: Page,
  acc: AccountDocument,
  oid: string,
  bot: TelegramBot,
  displayInfo?: DisplayInfo
) => {
  const chatId = (acc.user as UserDocument).telegramId;
  const SLOW_PAGE_TIMEOUT = 5 * 60 * 1000;
  const manualInterventionTime = 30 * 60 * 1000;

  try {
    // Check if page loaded correctly
    const pageTitle = (await page.title()).toLowerCase();
    if (
      pageTitle.includes("error") ||
      pageTitle.includes("unterbrechung") ||
      pageTitle.includes("http")
    ) {
      console.error(`⚠ Booking error detected for ${acc.email}, page title: ${pageTitle}`);
      
      // Retry navigation
      const retryUrl = `https://www.goethe.de/coe?lang=en&oid=${oid}`;
      await page.goto(retryUrl, {
        waitUntil: "domcontentloaded",
        timeout: SLOW_PAGE_TIMEOUT
      });
    }

    sendAccountLog(bot, chatId, acc, "🚀 Starting booking process...");

    // Add display info to initial notification if available
    if (displayInfo) {
      sendAccountLog(
        bot,
        chatId,
        acc,
        `🖥️ Browser running on display ${displayInfo.display}\n` +
        `🔗 noVNC Access: ${displayInfo.noVncUrl}\n` +
        `🔌 VNC Port: ${displayInfo.vncPort}`
      );
    }

    // Step 1: Select modules
    const availableModules = await selectAvailableModules(page, acc.modules);

    if (!availableModules.status) {
      await handleErrorWithBrowserAccess(
        bot,
        chatId,
        acc,
        `Required modules not available: ${availableModules.message}`,
        displayInfo,
        manualInterventionTime
      );
      return;
    }

    sendAccountLog(bot, chatId, acc, "✅ Selected modules, continuing booking...");

    // Step 2: Click "weiter" button
    await page.waitForSelector("button.cs-button--arrow_next", {
      visible: true,
      timeout: SLOW_PAGE_TIMEOUT,
    });
    await page.click("button.cs-button--arrow_next");
    console.log('✅ Clicked "weiter" button');

    await page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: SLOW_PAGE_TIMEOUT,
    });

    // Step 3: Click "Book for me" button
    await page.waitForSelector("button.cs-layer__button--high", {
      visible: true,
      timeout: SLOW_PAGE_TIMEOUT,
    });
    const bookForButtons = await page.$$("button.cs-layer__button--high");

    if (!bookForButtons[1]) {
      throw new Error("Could not find 'Book for me' button");
    }

    await bookForButtons[1].click();
    console.log('🎯 Clicked "Book for me" button');

    await page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: SLOW_PAGE_TIMEOUT,
    });

    // Step 4: Login
    await page.waitForSelector("#username", {
      visible: true,
      timeout: SLOW_PAGE_TIMEOUT
    });
    await page.type("#username", acc.email);
    await page.type("#password", acc.password);
    await page.click('input[type="submit"][name="submit"]');

    sendAccountLog(bot, chatId, acc, "✅ Submitted login form, waiting for response...");
    console.log("🚀 Submitted login form");
    await page.waitForNavigation({
      waitUntil: "networkidle2",
      timeout: SLOW_PAGE_TIMEOUT,
    });

    const bookingConflict = await handleBookingConflict(page);

    try {
      await page.click("button.cs-button--arrow_next");
      await page.waitForNavigation({
        waitUntil: "networkidle2",
        timeout: SLOW_PAGE_TIMEOUT,
      });
    } catch (err) {
      console.log("ℹ️ Error after login:", (err as Error).message);
      await handleErrorWithBrowserAccess(
        bot,
        chatId,
        acc,
        "Login failed or timed out. Please verify credentials and complete manually.",
        displayInfo,
        manualInterventionTime
      );
      return;
    }

    sendAccountLog(bot, chatId, acc, "✅ Login successful!");

    await page.click("button.cs-button--arrow_next");
    await page.waitForNavigation({
      waitUntil: "networkidle2",
      timeout: SLOW_PAGE_TIMEOUT,
    });

    // Handle booking conflict if present
    if (bookingConflict) {
      await page.click("button.cs-button--arrow_next");
      await page.waitForNavigation({
        waitUntil: "networkidle2",
        timeout: SLOW_PAGE_TIMEOUT,
      });
    }

    console.log("✅ Navigated to payment page");

    // Payment page reached - notify user
    let paymentMessage =
      "✅ **Reached Payment Page!**\n\n" +
      "💳 Please review all details and complete the payment manually.\n" +
      "⏳ You have approximately *30 minutes* to finish before the session expires.\n\n";

    if (displayInfo) {
      paymentMessage +=
        "🖥️ **Browser Access:**\n" +
        `🔗 **noVNC URL:** ${displayInfo.noVncUrl}\n` +
        `🖥️ **Display:** ${displayInfo.display}\n` +
        `🔌 **VNC Port:** ${displayInfo.vncPort}\n\n` +
        "💡 **Next Steps:**\n" +
        "1. Click the noVNC URL to access the browser\n" +
        "2. Complete the payment process\n" +
        "3. Browser will remain open for 30 minutes\n" +
        "4. Account will be auto-disabled after timeout";
    } else {
      paymentMessage +=
        "🖥️ Please log in to the RDP to access the browser and complete payment.";
    }

    sendAccountLog(bot, chatId, acc, paymentMessage);

    // Wait for manual payment completion (30 minutes)
    console.log(`⏳ Waiting ${manualInterventionTime / 60000} minutes for manual payment...`);
    await delay(manualInterventionTime);

    // After timeout, disable account
    acc.status = false;
    await acc.save();

    sendAccountLog(
      bot,
      chatId,
      acc,
      "⏰ **Session Timeout**\n\n" +
      "Account has been automatically disabled.\n" +
      "✅ If payment was completed, the booking should be confirmed.\n" +
      "❌ If payment was not completed, you may need to try again."
    );

    console.log(`✅ Booking process completed for ${acc.email}`);

  } catch (err) {
    console.error("❌ Unexpected error in booking process:", err);

    await handleErrorWithBrowserAccess(
      bot,
      chatId,
      acc,
      `Booking process encountered an error: ${(err as Error).message}`,
      displayInfo,
      manualInterventionTime
    );
  }
};

// OPTIMIZED: Main booking entry point with instant launch
const startBooking = async (
  page: Page,
  acc: AccountDocument,
  oid: string,
  bot: TelegramBot,
  displayInfo?: DisplayInfo,
  timeoutMs = 5 * 60 * 60 * 1000 // 5 hours for retry loop
) => {
  // Use the instant launcher for maximum speed
  await instantBookingLauncher(page, acc, oid, bot, displayInfo);
};

export default startBooking;
export { instantBookingLauncher, continueBookingProcess };