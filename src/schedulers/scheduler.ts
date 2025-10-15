import { bot } from "..";
import { examMonitor } from "../api/exam-api-finder";
import { runAllAccountsWithPrewarmedBrowsers } from "../cluster/runCluster";
import Schedule, { ISchedule } from "../models/scheduleSchema";
import User, { UserDocument } from "../models/userSchema";
import Account from "../models/accountSchema";
import { DateTime } from "luxon";
import { browserPool } from "../browsers/prewarmedBrowserPool";

interface ActiveSession {
  scheduleId: string;
  targetTime: Date;
  startedAt: Date;
  userId?: string;
  status: "monitoring" | "processing" | "paused" | "warming" | "completed" | "failed";
  browsersPrewarmed?: boolean;
}

class ExamScheduler {
  private activeMonitoringSessions = new Map<string, ActiveSession>();
  private schedulerInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  start(): void {
    if (this.isRunning) {
      console.log("⚠️ Scheduler already running");
      return;
    }

    console.log("🚀 Starting Future Schedule Monitor (2min before UTC)...");
    this.isRunning = true;

    // Check every 15 seconds for schedules that need monitoring
    this.schedulerInterval = setInterval(async () => {
      try {
        await this.checkFutureSchedules();
      } catch (error) {
        console.error("❌ Scheduler error:", error);
      }
    }, 15000);

    // Initial check
    this.checkFutureSchedules().catch((error) => {
      console.error("❌ Initial check failed:", error);
    });

    console.log("✅ Future Schedule Monitor started");
  }

  stop(): void {
    if (!this.isRunning) {
      console.log("⚠️ Scheduler not running");
      return;
    }

    console.log("🛑 Stopping scheduler...");

    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }

    this.isRunning = false;
    console.log("✅ Scheduler stopped");
  }

  private async checkFutureSchedules(): Promise<void> {
    try {
      const nowUtc = DateTime.utc();

      // Calculate the 2-minute monitoring window
      const monitoringWindowStart = nowUtc.toJSDate();
      const monitoringWindowEnd = nowUtc.plus({ minutes: 2 }).toJSDate();

      // Find future schedules that should start monitoring now
      const schedulesToMonitor = await Schedule.find({
        runAt: {
          $gt: monitoringWindowStart,
          $lte: monitoringWindowEnd
        },
        completed: false,
        status: { $nin: ["running", "paused", "success"] },
        monitoringStarted: { $ne: true }
      }).populate("createdBy");

      if (schedulesToMonitor.length > 0) {
        console.log(
          `🔍 Found ${schedulesToMonitor.length} future schedule(s) ready for monitoring`
        );
        console.log(`📅 Current UTC: ${nowUtc.toISO()}`);
      }

      for (const schedule of schedulesToMonitor) {
        const scheduleTimeUtc = DateTime.fromJSDate(schedule.runAt, { zone: 'utc' });
        const minutesUntil = scheduleTimeUtc.diff(nowUtc, 'minutes').minutes;

        console.log(
          `⏰ Schedule "${schedule.name}" at ${scheduleTimeUtc.toISO()} (${minutesUntil.toFixed(1)} min away)`
        );

        try {
          await this.startMonitoringSession(schedule);
        } catch (error) {
          console.error(
            `❌ Failed to start monitoring for ${schedule.name}:`,
            error
          );
          await this.updateScheduleWithError(
            schedule.id,
            error,
            "Failed to start monitoring"
          );
        }
      }

      await this.cleanupCompletedSessions();
    } catch (error) {
      console.error("❌ Error checking future schedules:", error);
    }
  }

  private async startMonitoringSession(schedule: ISchedule) {
    const scheduleId = schedule.id.toString();
    const user = schedule.createdBy as unknown as UserDocument;

    console.log(`🎯 Starting monitoring session for: ${schedule.name}`);

    const session: ActiveSession = {
      scheduleId,
      userId: user._id.toString(),
      targetTime: schedule.runAt,
      status: "warming",
      startedAt: new Date(),
      browsersPrewarmed: false,
    };

    this.activeMonitoringSessions.set(scheduleId, session);

    // Update schedule status
    await Schedule.findByIdAndUpdate(scheduleId, {
      status: "monitoring",
      monitoringStarted: true,
    });

    // Send initial notification
    if (user.telegramId) {
      await bot.sendMessage(
        user.telegramId,
        `🚀 **Monitoring Started**\n\n` +
        `📋 Name: ${schedule.name}\n` +
        `⏰ Scheduled: ${schedule.runAt.toLocaleString()}\n` +
        `🔥 Warming up 20 browsers...\n` +
        `🔍 Will start polling for exam OID...\n\n` +
        `You'll be notified when an OID is found!`,
        { parse_mode: "Markdown" }
      );
    }

    try {
      // Step 1: Warm up 20 browsers
      console.log(`🔥 Warming up 20 browsers for ${schedule.name}...`);
      await browserPool.warmup20Browsers();
      
      session.browsersPrewarmed = true;
      session.status = "monitoring";

      if (user.telegramId) {
        await bot.sendMessage(
          user.telegramId,
          `✅ **20 Browsers Ready**\n\n` +
          `📋 ${schedule.name}\n` +
          `🔥 All browsers prewarmed and ready\n` +
          `🔍 Now polling for exam OID...`,
          { parse_mode: "Markdown" }
        );
      }

      // Step 2: Start polling for OID
      console.log(`🔍 Starting OID polling for ${schedule.name}...`);

      await examMonitor.startPolling({
        interval: 2000,
        maxDurationMs: 5 * 60 * 60 * 1000,

        onOidFound: async (oid: string, exam: any) => {
          console.log(`🎯 OID FOUND: ${oid}`);

          session.status = "processing";

          // Notify OID found
          if (user.telegramId) {
            await bot.sendMessage(
              user.telegramId,
              `🎯 **EXAM FOUND!**\n\n` +
              `🆔 OID: ${oid}\n` +
              `📍 Location: ${exam.locationName || "Unknown"}\n` +
              `📅 Event: ${exam.eventName || "Unknown"}\n\n` +
              `⚡ Redirecting 20 prewarmed browsers NOW!`,
              { parse_mode: "Markdown" }
            );
          }

          // Step 3: Use prewarmed browsers to navigate to OID URL
          await this.launchPrewarmedBrowsers(oid, scheduleId, user);

          session.status = "completed";
          
          // Mark schedule as complete
          await Schedule.findByIdAndUpdate(scheduleId, {
            completed: true,
            status: "success",
            lastRun: new Date(),
          });

          this.activeMonitoringSessions.delete(scheduleId);
        },

        onTimeout: async () => {
          console.log(`⏰ Monitoring timeout for ${schedule.name}`);

          await Schedule.findByIdAndUpdate(scheduleId, {
            completed: true,
            status: "failed",
            lastRun: new Date(),
            lastError: "No OID found within monitoring period (30 minutes)",
          });

          if (user.telegramId) {
            await bot.sendMessage(
              user.telegramId,
              `⏰ **Monitoring Timeout**\n\n` +
              `📋 Schedule: ${schedule.name}\n` +
              `❌ No exam OID found within 30 minutes\n\n` +
              `The schedule has been marked as failed.`,
              { parse_mode: "Markdown" }
            );
          }

          // Close all prewarmed browsers
          await browserPool.closeAllBrowsers();

          session.status = "failed";
          this.activeMonitoringSessions.delete(scheduleId);
        },
      });
    } catch (error) {
      console.error(`❌ Error in monitoring session:`, error);

      await Schedule.findByIdAndUpdate(scheduleId, {
        completed: true,
        status: "failed",
        lastRun: new Date(),
        lastError: (error as Error).message,
      });

      if (user.telegramId) {
        await bot.sendMessage(
          user.telegramId,
          `❌ **Monitoring Failed**\n\n` +
          `📋 ${schedule.name}\n` +
          `Error: ${(error as Error).message}`,
          { parse_mode: "Markdown" }
        );
      }

      // Close browsers on error
      await browserPool.closeAllBrowsers();

      session.status = "failed";
      this.activeMonitoringSessions.delete(scheduleId);
    }
  }

  private async launchPrewarmedBrowsers(
    oid: string,
    scheduleId: string,
    user: UserDocument
  ): Promise<void> {
    try {
      console.log(`⚡ Using runCluster to redirect prewarmed browsers to OID ${oid}`);

      if (user.telegramId) {
        await bot.sendMessage(
          user.telegramId,
          `⚡ **Launching Browsers**\n\n` +
          `🌐 Redirecting all prewarmed browsers to booking page in parallel...\n` +
          `🆔 OID: ${oid}`,
          { parse_mode: "Markdown" }
        );
      }

      // Use runCluster which handles parallel navigation and booking
      await runAllAccountsWithPrewarmedBrowsers(oid, scheduleId);

    } catch (error) {
      console.error(`❌ Error launching prewarmed browsers:`, error);
      throw error;
    }
  }

  private async handleScheduleFailure(
    scheduleId: string,
    error: any,
    telegramId: string
  ): Promise<void> {
    const schedule = await Schedule.findById(scheduleId);
    if (!schedule) return;

    const errorMessage =
      (error as any).message || error.toString() || "Unknown error";

    await Schedule.findByIdAndUpdate(scheduleId, {
      completed: true,
      status: "failed",
      lastError: errorMessage,
      lastRun: new Date(),
    });

    await this.sendLogToUser(
      telegramId,
      `❌ **Schedule Failed**\n\n` +
      `📋 ${schedule.name}\n` +
      `🚨 Error: ${errorMessage}`
    );

    this.activeMonitoringSessions.delete(scheduleId);
  }

  async pauseSchedule(scheduleId: string): Promise<void> {
    const session = this.activeMonitoringSessions.get(scheduleId);
    if (session) {
      session.status = "paused";
    }

    // Stop monitoring
    examMonitor.stopPolling();

    await Schedule.findByIdAndUpdate(scheduleId, { status: "paused" });

    const schedule = await Schedule.findById(scheduleId).populate("createdBy");
    if (schedule?.createdBy) {
      const user = schedule.createdBy as any;
      if (user.telegramId) {
        await this.sendLogToUser(
          user.telegramId,
          `⏸️ **Schedule Paused**\n📋 ${schedule.name}`
        );
      }
    }
  }

  async resumeSchedule(scheduleId: string): Promise<void> {
    const schedule = await Schedule.findById(scheduleId).populate("createdBy");
    if (!schedule || schedule.status !== "paused") {
      throw new Error("Schedule not paused or not found");
    }

    await Schedule.findByIdAndUpdate(scheduleId, {
      status: "pending",
      monitoringStarted: false,
    });

    await this.startMonitoringSession(schedule);
  }

  async stopSchedule(scheduleId: string): Promise<void> {
    const session = this.activeMonitoringSessions.get(scheduleId);
    if (session) {
      this.activeMonitoringSessions.delete(scheduleId);
    }

    // Stop monitoring and close browsers
    examMonitor.stopPolling();
    await browserPool.closeAllBrowsers();

    await Schedule.findByIdAndUpdate(scheduleId, {
      completed: true,
      status: "stopped",
      lastError: "Stopped by user",
      lastRun: new Date(),
    });
  }

  private async updateScheduleWithError(
    scheduleId: string,
    error: any,
    context: string
  ): Promise<void> {
    const errorMessage =
      (error as any).message || error.toString() || "Unknown error";

    await Schedule.findByIdAndUpdate(scheduleId, {
      monitoringStarted: false,
      status: "failed",
      lastError: `${context}: ${errorMessage}`,
      lastRun: new Date(),
    });
  }

  private async sendLogToUser(
    telegramId: string,
    message: string
  ): Promise<void> {
    try {
      await bot.sendMessage(telegramId, message, { parse_mode: "Markdown" });
    } catch (error) {
      console.error(`❌ Failed to send message to ${telegramId}:`, error);
    }
  }

  private async cleanupCompletedSessions(): Promise<void> {
    const nowUtc = DateTime.utc();
    const expiredSessions: string[] = [];

    for (const [scheduleId, session] of this.activeMonitoringSessions.entries()) {
      const targetTimeUtc = DateTime.fromJSDate(session.targetTime, { zone: 'utc' });
      const expiryTime = targetTimeUtc.plus({ minutes: 30 });

      if (nowUtc > expiryTime && session.status !== "processing") {
        console.log(`🧹 Cleaning up expired session: ${scheduleId}`);
        expiredSessions.push(scheduleId);
      }
    }

    for (const scheduleId of expiredSessions) {
      this.activeMonitoringSessions.delete(scheduleId);
      await this.handleScheduleFailure(scheduleId, "Session expired", "");
    }
  }

  getStatus(): any {
    const nowUtc = DateTime.utc();
    const sessions = Array.from(this.activeMonitoringSessions.values()).map(
      (session) => {
        const startedUtc = DateTime.fromJSDate(session.startedAt, { zone: 'utc' });
        const targetUtc = DateTime.fromJSDate(session.targetTime, { zone: 'utc' });
        const runningSeconds = nowUtc.diff(startedUtc, 'seconds').seconds;

        return {
          scheduleId: session.scheduleId,
          targetTime: targetUtc.toISO(),
          startedAt: startedUtc.toISO(),
          runningFor: `${Math.round(runningSeconds)}s`,
          status: session.status,
          browsersPrewarmed: session.browsersPrewarmed || false,
        };
      }
    );

    return {
      isRunning: this.isRunning,
      activeSessions: this.activeMonitoringSessions.size,
      currentTimeUtc: nowUtc.toISO(),
      sessions,
    };
  }

  async stopAllMonitoring(): Promise<void> {
    console.log(`🛑 Stopping ${this.activeMonitoringSessions.size} active sessions`);
    examMonitor.destroy();
    await browserPool.closeAllBrowsers();
    this.activeMonitoringSessions.clear();
  }

  async triggerSchedule(scheduleId: string): Promise<void> {
    const schedule = await Schedule.findById(scheduleId).populate("createdBy");
    if (!schedule || schedule.completed) {
      throw new Error("Schedule not found or already completed");
    }

    await Schedule.findByIdAndUpdate(scheduleId, {
      status: "pending",
      monitoringStarted: false,
      lastError: null,
    });

    await this.startMonitoringSession(schedule);
  }

  async getScheduleInfo(scheduleId: string): Promise<any> {
    const schedule = await Schedule.findById(scheduleId).populate("createdBy");
    const session = this.activeMonitoringSessions.get(scheduleId);

    return {
      schedule,
      isMonitoring: !!session,
      session,
    };
  }
}

const examScheduler = new ExamScheduler();

// Graceful shutdown handlers
process.on("SIGINT", async () => {
  console.log("\n🛑 SIGINT - shutting down gracefully...");
  examScheduler.stop();
  await examScheduler.stopAllMonitoring();
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 SIGTERM - shutting down gracefully...");
  examScheduler.stop();
  await examScheduler.stopAllMonitoring();
});

export { examScheduler, ExamScheduler };