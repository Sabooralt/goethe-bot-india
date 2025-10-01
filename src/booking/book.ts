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

  try {
    bot.sendMessage(chatId, fullMessage, { parse_mode: "Markdown" });
    console.log(fullMessage);
  } catch (error) {
    console.error("Failed to send Telegram message:", error);
  }
};

const startBooking = async (
  page: Page,
  acc: AccountDocument,
  oid: string,
  bot: TelegramBot,
  displayInfo?: DisplayInfo,
  timeoutMs = 5 * 60 * 60 * 1000
) => {
  const chatId = (acc.user as UserDocument).telegramId;
  const startTime = Date.now();

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

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      sendAccountLog(
        bot,
        chatId,
        acc,
        "⏰ Booking retry timeout reached (5 hours). Stopping booking."
      );
      return;
    }

    await page.goto(`https://www.goethe.de/coe?lang=en&oid=${oid}`, {
      waitUntil: "domcontentloaded",
    });

    const pageTitle = (await page.title()).toLowerCase();
    if (
      pageTitle.includes("error") ||
      pageTitle.includes("unterbrechung") ||
      /http\s?\d{3}/i.test(pageTitle)
    ) {
      console.error(
        `❗ Booking error detected, retrying... (elapsed ${Math.round(
          elapsed / 60000
        )} min)`
      );

      sendAccountLog(
        bot,
        chatId,
        acc,
        `❗ Booking error detected, retrying...\nElapsed: ${Math.round(
          elapsed / 60000
        )} minutes`
      );

      await delay(5000);
      continue;
    }

    // Success – break retry loop
    break;
  }

  try {
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

    const availableModules = await selectAvailableModules(page, acc.modules);

    if (!availableModules) {
      sendAccountLog(
        bot,
        chatId,
        acc,
        "❌ Required modules not available, stopping booking."
      );
      return;
    }

    sendAccountLog(bot, chatId, acc, "Selected modules, continuing booking...");

    await page.waitForSelector("button.cs-button--arrow_next", {
      visible: true,
    });
    await page.click("button.cs-button--arrow_next");
    console.log('✅ Clicked "weiter" button');

    await page.waitForNavigation({
      waitUntil: "domcontentloaded",
    });

    await page.waitForSelector("button.cs-layer__button--high", {
      visible: true,
    });
    const bookForButtons = await page.$$("button.cs-layer__button--high");
    await bookForButtons[1]?.click();
    console.log('🎯 Clicked "Book for me" button');

    await page.waitForNavigation({
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("#username", { visible: true });
    await page.type("#username", acc.email);

    await page.type("#password", acc.password);

    await page.click('input[type="submit"][name="submit"]');
    sendAccountLog(bot, chatId, acc, "✅ Submitted out login form");
    console.log("🚀 Submitted login form");

    try {
      await page.waitForNavigation({
        waitUntil: "networkidle2",
      });
    } catch (err) {
      console.log(" ℹ️ Error logging in:" + (err as Error).message);
      sendAccountLog(
        bot,
        chatId,
        acc,
        "❌ Error logging in, Please verify credentials."
      );
      return;
    }

    const bookingConflict = await handleBookingConflict(page);

    await page.click("button.cs-button--arrow_next");

    try {
      await page.waitForNavigation({
        waitUntil: "networkidle2",
      });
      console.log("✅ Navigated after DOB form");
    } catch {
      console.log("ℹ️ No navigation after DOB form (skipped step?)");
    }

    await page.click("button.cs-button--arrow_next");
    await page.waitForNavigation({
      waitUntil: "networkidle2",
    });

    if (bookingConflict) {
      await page.click("button.cs-button--arrow_next");
      await page.waitForNavigation({
        waitUntil: "networkidle2",
      });
    }

    console.log("✅ Navigated to payment page");

    let paymentMessage =
      "✅ Redirected to the payment page.\n" +
      "💳 Please review all the details and complete the payment manually.\n" +
      "⏳ You have approximately *30 minutes* to finish the payment before the session expires.\n\n";

    if (displayInfo) {
      paymentMessage +=
        "🖥️ **Manual Access Available:**\n" +
        `🔗 **noVNC URL:** ${displayInfo.noVncUrl}\n` +
        `🖥️ **Display:** ${displayInfo.display}\n` +
        `🔌 **VNC Port:** ${displayInfo.vncPort}\n\n` +
        "💡 **Instructions:**\n" +
        "• Click the noVNC URL to access the browser remotely\n" +
        "• Complete the payment process manually\n" +
        "• The browser will remain open for manual interaction\n" +
        "• Session will timeout in approximately 30 minutes";
    } else {
      paymentMessage +=
        "🖥️ Please log in to the RDP to access the browser and complete payment.";
    }

    sendAccountLog(bot, chatId, acc, paymentMessage);

    // Keep account active for manual payment completion
    // Don't set acc.status = false here since user needs to complete payment manually

    // Wait for 30 minutes to allow manual payment completion
    await delay(1800000);

    // After timeout, disable account (payment should be completed by now)
    acc.status = false;
    await acc.save();

    sendAccountLog(
      bot,
      chatId,
      acc,
      "⏰ Session timeout reached. Account has been disabled.\n" +
        "✅ If payment was completed successfully, the booking should be confirmed."
    );
  } catch (err) {
    sendAccountLog(
      bot,
      chatId,
      acc,
      `❌ Booking process failed: ${(err as Error).message}` +
        (displayInfo
          ? `\n🖥️ You can still access the browser at: ${displayInfo.noVncUrl}`
          : "")
    );
    console.error("Error in startBooking:", err);
  }
};

export default startBooking;
