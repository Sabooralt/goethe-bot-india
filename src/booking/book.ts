import { Page } from "puppeteer";
import dotenv from "dotenv";
import type TelegramBot from "node-telegram-bot-api";

dotenv.config();

interface DisplayInfo {
  display: string;
  displayNumber: string;
  noVncUrl: string;
  vncPort: number;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const sendLog = (
  bot: TelegramBot,
  chatId: string | null,
  browserNumber: number,
  message: string
) => {
  if (!chatId) return;

  const fullMessage = `[Browser ${browserNumber}] ${message}`;

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
 * SIMPLIFIED: Just handle retries until page loads successfully
 * Then notify user to complete booking manually
 */
const startBooking = async (
  page: Page,
  browserNumber: number,
  oid: string,
  bot: TelegramBot,
  displayInfo: DisplayInfo,
  chatId: string | null,
  timeoutMs = 5 * 60 * 60 * 1000 // 5 hours for retry loop
) => {
  const startTime = Date.now();
  const bookingUrl = `https://www.goethe.de/coe?lang=en&oid=${oid}`;
  const SLOW_PAGE_TIMEOUT = 5 * 60 * 1000;

  try {
    const pageTitle = (await page.title()).toLowerCase();

    // Check if page loaded successfully
    if (
      pageTitle.includes("options")
    ) {
      // SUCCESS - Page loaded correctly!
      console.log(`✅ Browser ${browserNumber}: Page loaded successfully!`);

      sendLog(
        bot,
        chatId,
        browserNumber,
        `✅ **PAGE LOADED SUCCESSFULLY!**\n\n` +
        `🖥️ **Display:** ${displayInfo.display}\n` +
        `🔗 **noVNC URL:** ${displayInfo.noVncUrl}\n` +
        `📌 **VNC Port:** ${displayInfo.vncPort}\n\n` +
        `💡 **You can now complete the booking manually:**\n` +
        `1. Click the noVNC URL to access the browser\n` +
        `2. Complete the booking process\n` +
        `3. Browser will remain open for manual use\n\n` +
        `⏱️ Loaded in: ${Math.round((Date.now() - startTime) / 1000)}s`
      );

      // Keep browser open indefinitely for manual booking
      console.log(
        `🖥️ Browser ${browserNumber}: Keeping browser open for manual booking...`
      );
      await delay(1800000)

      return;
    }

    // Error detected - start retry loop
    console.log(
      `⚠️ Browser ${browserNumber}: Error detected in page title: ${pageTitle}`
    );
    console.log(`🔄 Browser ${browserNumber}: Starting 5-hour retry loop...`);

    sendLog(
      bot,
      chatId,
      browserNumber,
      `⚠️ Error detected, starting retry loop...\n` +
      `Page title: ${pageTitle}\n` +
      `Will retry for 5 hours.`
    );

    // START RETRY LOOP - only when error detected
    let attempts = 0;
    while (true) {
      const elapsed = Date.now() - startTime;

      if (elapsed > timeoutMs) {
        console.log(`⏰ Browser ${browserNumber}: 5 hour timeout reached`);
        sendLog(
          bot,
          chatId,
          browserNumber,
          "⏰ Retry timeout reached (5 hours). Stopping retries."
        );
        return;
      }

      attempts++;



      try {
        await page.goto(bookingUrl, {
          waitUntil: "domcontentloaded",
          timeout: SLOW_PAGE_TIMEOUT,
        });

        const retryPageTitle = (await page.title()).toLowerCase();

        if (
          !retryPageTitle.includes("options")
        ) {
          console.log(
            `⚠️ Browser ${browserNumber}: Still seeing error (attempt ${attempts}): ${retryPageTitle}`
          );

          // Notify every 20 attempts
          if (attempts % 20 === 0) {
            sendLog(
              bot,
              chatId,
              browserNumber,
              `⚠️ Still retrying...\n` +
              `Attempt: ${attempts}\n` +
              `Error: ${retryPageTitle}\n` +
              `Elapsed: ${Math.round(elapsed / 60000)} min\n` +
              `Remaining: ${Math.round((timeoutMs - elapsed) / 60000)} min`
            );
          }
          await delay(5000)
          continue;
        }

        // SUCCESS - Error resolved!
        console.log(
          `✅ Browser ${browserNumber}: Page loaded successfully after ${attempts} attempts!`
        );

        sendLog(
          bot,
          chatId,
          browserNumber,
          `✅ **PAGE LOADED SUCCESSFULLY!**\n\n` +
          `🖥️ **Display:** ${displayInfo.display}\n` +
          `🔗 **noVNC URL:** ${displayInfo.noVncUrl}\n` +
          `📌 **VNC Port:** ${displayInfo.vncPort}\n\n` +
          `🔄 **Attempts:** ${attempts}\n` +
          `⏱️ **Time:** ${Math.round(elapsed / 1000)}s\n\n` +
          `💡 **You can now complete the booking manually:**\n` +
          `1. Click the noVNC URL to access the browser\n` +
          `2. Complete the booking process\n` +
          `3. Browser will remain open for manual use`
        );

        // Keep browser open indefinitely for manual booking
        console.log(
          `🖥️ Browser ${browserNumber}: Keeping browser open for manual booking...`
        );
        await delay(1800000)
        return
      } catch (navError) {
        console.error(
          `❌ Browser ${browserNumber}: Navigation error (attempt ${attempts}):`,
          (navError as Error).message
        );

        // Notify on critical errors every 30 attempts
        if (attempts % 30 === 0) {
          sendLog(
            bot,
            chatId,
            browserNumber,
            `❌ Navigation error\n` +
            `Attempt: ${attempts}\n` +
            `Elapsed: ${Math.round(elapsed / 60000)} min\n` +
            `Will keep retrying...`
          );
        }
      }
    }
  } catch (err) {
    console.error(`❌ Browser ${browserNumber}: Unexpected error:`, err);
    sendLog(
      bot,
      chatId,
      browserNumber,
      `❌ Unexpected error: ${(err as Error).message}\n\n` +
      `🖥️ Display: ${displayInfo.display}\n` +
      `🔗 noVNC: ${displayInfo.noVncUrl}\n\n` +
      `You may need to access manually.`
    );
    await delay(1800000)
  }
};

export default startBooking;
