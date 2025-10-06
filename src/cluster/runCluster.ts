import Account from "../models/accountSchema";
import startBooking from "../booking/book";
import { bot } from "..";
import Schedule, { ISchedule } from "../models/scheduleSchema";
import { UserDocument } from "../models/userSchema";
import dotenv from "dotenv";
import { browserPool } from "../browsers/preWarmedBrowserPool";

dotenv.config();

interface DisplayInfo {
  display: string;
  displayNumber: string;
  noVncUrl: string;
  vncPort: number;
}

export const runAllAccountsWithPrewarmedBrowsers = async (
  oid: string,
  scheduleId?: string
) => {
  let schedule: ISchedule | null = null;
  let user: UserDocument | null = null;

  try {
    console.log("⚡ INSTANT START - Using pre-warmed browsers!");

    if (scheduleId) {
      schedule = await Schedule.findById(scheduleId).populate("createdBy");
      if (schedule?.createdBy) {
        user = schedule.createdBy as any;
      }
    }

    let accounts;
    if (user) {
      console.log(`👤 Fetching accounts for user: ${user.telegramId}`);
      accounts = await Account.find({
        status: true,
        user: user._id,
      }).populate("user");
      console.log(`✅ Found ${accounts.length} accounts for this user`);
    } else {
      accounts = await Account.find({ status: true }).populate("user");
    }

    if (!accounts || accounts.length === 0) {
      console.log("❌ No active accounts");

      if (scheduleId) {
        await Schedule.findByIdAndUpdate(scheduleId, {
          completed: true,
          status: "failed",
          lastRun: new Date(),
          lastError: "No active accounts found",
        });
      }

      if (user?.telegramId && schedule) {
        await bot.sendMessage(
          user.telegramId,
          `❌ **Schedule Failed**\n` +
            `📋 Schedule: ${schedule.name}\n` +
            `🚨 Error: No active accounts\n` +
            `💡 Add active accounts and retry.`,
          { parse_mode: "Markdown" }
        );
      }

      return;
    }

    const poolStatus = browserPool.getStatus();
    console.log(
      `📊 Browser pool: ${poolStatus.readyBrowsers}/${accounts.length} ready`
    );

    if (user?.telegramId && schedule) {
      await bot.sendMessage(
        user.telegramId,
        `⚡ **INSTANT BOOKING START**\n` +
          `📋 Schedule: ${schedule.name}\n` +
          `🆔 OID: ${oid}\n` +
          `🔥 Pre-warmed: ${poolStatus.readyBrowsers}/${accounts.length}\n` +
          `⚡ Starting all accounts NOW...`,
        { parse_mode: "Markdown" }
      );
    }

    let successCount = 0;
    let errorCount = 0;

    const bookingPromises = accounts.map(async (account) => {
      try {
        const prewarmed = browserPool.getPrewarmedBrowser(account.email);

        if (prewarmed) {
          console.log(
            `⚡ INSTANT: Using pre-warmed browser for ${account.email}`
          );

          const displayNumber = parseInt(prewarmed.display.replace(":", ""));
          const displayInfo: DisplayInfo = {
            display: prewarmed.display,
            displayNumber: prewarmed.display.replace(":", ""),
            noVncUrl: `http://${process.env.SERVER_IP || "localhost"}:${
              6080 + displayNumber
            }/vnc.html`,
            vncPort: 5900 + displayNumber,
          };

          await startBooking(prewarmed.page, account, oid, bot, displayInfo, 3);

          await browserPool.closeBrowser(account.email);

          successCount++;
          console.log(`✅ ${account.email} completed`);
        } else {
          console.log(
            `⚠️ No pre-warmed browser for ${account.email}, skipping`
          );
          errorCount++;
        }
      } catch (error: any) {
        errorCount++;
        console.error(`❌ ${account.email} failed:`, error.message);

        const accountUser = account.user as any;
        if (
          accountUser &&
          typeof accountUser === "object" &&
          accountUser.telegramId
        ) {
          await bot.sendMessage(
            accountUser.telegramId,
            `❌ **Booking Failed**\n` +
              `📧 ${account.email}\n` +
              `🚨 ${error.message}`,
            { parse_mode: "Markdown" }
          );
        }
      }
    });

    await Promise.allSettled(bookingPromises);

    console.log(
      `✅ All bookings processed! Success: ${successCount}, Errors: ${errorCount}`
    );

    await browserPool.closeAllBrowsers();

    if (scheduleId) {
      const isSuccess = errorCount === 0;

      await Schedule.findByIdAndUpdate(scheduleId, {
        completed: true,
        status: isSuccess ? "success" : "partial_success",
        lastRun: new Date(),
        lastError: isSuccess ? null : `${errorCount} accounts failed`,
      });
    }

    if (user?.telegramId && schedule) {
      const statusIcon = errorCount === 0 ? "✅" : "⚠️";
      const statusText =
        errorCount === 0 ? "Completed Successfully" : "Completed with Errors";

      await bot.sendMessage(
        user.telegramId,
        `${statusIcon} **Schedule ${statusText}**\n` +
          `📋 ${schedule.name}\n` +
          `👥 Total: ${accounts.length}\n` +
          `✅ Success: ${successCount}\n` +
          `❌ Errors: ${errorCount}\n` +
          `⏰ Completed: ${new Date().toLocaleString()}`,
        { parse_mode: "Markdown" }
      );
    }
  } catch (error: any) {
    console.error("❌ Booking error:", error);
    await browserPool.closeAllBrowsers();

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
        `❌ **Schedule Failed**\n` +
          `📋 ${schedule.name}\n` +
          `🚨 Error: ${error.message}`,
        { parse_mode: "Markdown" }
      );
    }

    throw error;
  }
};
