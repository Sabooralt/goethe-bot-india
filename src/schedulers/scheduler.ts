import { bot } from "..";
import { examMonitor } from "../api/exam-api-finder";
import { runAllAccountsWithPrewarmedBrowsers, ultraFastDirectLaunch } from "../cluster/runCluster";
import Schedule, { ISchedule } from "../models/scheduleSchema";
import User from "../models/userSchema";
import Account from "../models/accountSchema";
import { DateTime } from "luxon";
import { browserPool } from "../browsers/prewarmedBrowserPool";

interface ActiveSession {
  scheduleId: string;
  targetTime: Date;
  startedAt: Date;
  userId?: string;
  retryCount: number;
  maxRetries: number;
  lastAttemptTime?: Date;
  status: "monitoring" | "processing" | "paused" | "retrying";
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

    console.log("🚀 Starting OPTIMIZED scheduler with instant response...");
    this.isRunning = true;

    this.schedulerInterval = setInterval(async () => {
      try {
        await this.checkAndStartMonitoring();
      } catch (error) {
        console.error("❌ Scheduler error:", error);
      }
    }, 20000);

    this.checkAndStartMonitoring().catch((error) => {
      console.error("❌ Initial check failed:", error);
    });

    console.log("✅ Optimized scheduler started - INSTANT RESPONSE MODE");
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

  private async checkAndStartMonitoring(): Promise<void> {
    try {
      const nowUtc = DateTime.utc().toJSDate();
      const monitoringStartTimeUtc = DateTime.utc()
        .plus({ minutes: 5 })
        .toJSDate();

      const schedulesToMonitor = await Schedule.find({
        runAt: {
          $gte: nowUtc,
          $lte: monitoringStartTimeUtc,
        },
        completed: false,
        status: { $nin: ["running", "paused"] },
        monitoringStarted: { $ne: true },
      }).populate("createdBy");

      if (schedulesToMonitor.length > 0) {
        console.log(`🔍 Found ${schedulesToMonitor.length} schedules ready`);
      }

      for (const schedule of schedulesToMonitor) {
        try {
          await this.startMonitoringForSchedule(schedule);
        } catch (error) {
          console.error(
            `❌ Failed to start monitoring ${schedule._id}:`,
            error
          );
          await this.updateScheduleWithError(
            schedule.id,
            error,
            "Failed to start"
          );
        }
      }

      await this.checkForAutomaticRetries();
      await this.cleanupCompletedSessions();
    } catch (error) {
      console.error("❌ Error checking schedules:", error);
    }
  }

  private async startMonitoringForSchedule(
    schedule: ISchedule,
    isRetry: boolean = false
  ): Promise<void> {
    const scheduleId = schedule.id.toString();

    if (this.activeMonitoringSessions.has(scheduleId)) {
      const session = this.activeMonitoringSessions.get(scheduleId)!;
      if (session.status === "paused") {
        console.log(`🔄 Resuming ${schedule.name}`);
        session.status = "monitoring";
      } else {
        console.log(`⚠️ Already monitoring ${schedule.name}`);
        return;
      }
    }

    const user = await User.findById(schedule.createdBy);
    if (!user) {
      console.error(`❌ User not found for ${schedule.name}`);
      await this.updateScheduleWithError(
        scheduleId,
        "User not found",
        "User validation failed"
      );
      return;
    }

    const retryCount = (schedule as any).retryCount || 0;
    const maxRetries = (schedule as any).maxRetries || 5;

    // CRITICAL OPTIMIZATION: Start pre-warming browsers IMMEDIATELY
    const accountCount = await Account.countDocuments({
      user: user.id,
      status: true,
    });

    if (accountCount > 0) {
      console.log(
        `🔥🔥🔥 INSTANT PRE-WARMING: ${accountCount} browsers starting NOW!`
      );
      
      // Don't await - let it run in background for speed
      browserPool.warmupBrowsersForUser(user.id)
        .then(() => {
          console.log(`✅ All browsers pre-warmed and pre-navigated!`);
          const session = this.activeMonitoringSessions.get(scheduleId);
          if (session) {
            session.browsersPrewarmed = true;
          }
        })
        .catch((error) => {
          console.error("❌ Browser pre-warming failed:", error);
        });
    }

    if (isRetry) {
      await this.sendLogToUser(
        user.telegramId,
        `🔄 **Retry Attempt ${retryCount + 1}/${maxRetries}**\n` +
        `📋 Schedule: ${schedule.name}\n` +
        `📅 Target: ${schedule.runAt.toLocaleString()}\n` +
        `🔥 Pre-warming ${accountCount} browsers...\n` +
        `⚡ Starting ultra-fast monitoring...`
      );
    } else {
      await this.sendLogToUser(
        user.telegramId,
        `⚡⚡ **ULTRA-FAST MODE ACTIVATED**\n` +
        `📋 Schedule: ${schedule.name}\n` +
        `📅 Target: ${schedule.runAt.toLocaleString()}\n` +
        `🔥 Pre-warming ${accountCount} browsers NOW!\n` +
        `⚡ Polling every 2 seconds for instant response\n` +
        `🚀 All browsers will launch SIMULTANEOUSLY when OID found`
      );
    }

    console.log(`🎯 Starting INSTANT monitoring: ${schedule.name}`);

    await Schedule.findByIdAndUpdate(schedule._id, {
      status: "running",
      monitoringStarted: true,
      lastError: null,
      retryCount: isRetry ? retryCount + 1 : retryCount,
      lastAttemptTime: new Date(),
    });

    this.activeMonitoringSessions.set(scheduleId, {
      scheduleId,
      targetTime: schedule.runAt,
      startedAt: new Date(),
      userId: user.telegramId,
      retryCount: isRetry ? retryCount + 1 : retryCount,
      maxRetries,
      status: "monitoring",
      browsersPrewarmed: false,
    });

    try {
      await examMonitor.startPolling(schedule.runAt, {
        interval: 2000, // OPTIMIZED: 2 second polling for fastest response
        maxDurationMs: 30 * 60 * 1000,
        onExamFound: async (exam) => {
          console.log(`📋 [${schedule.name}] Exam detected (no OID yet)`);

          const status = browserPool.getStatus();
          
          // Non-blocking notification
          setImmediate(() => {
            this.sendLogToUser(
              user.telegramId,
              `📋 **Exam Detected**\n` +
              `📋 Schedule: ${schedule.name}\n` +
              `✅ Found exam with ${exam.modules?.length || 0} modules\n` +
              `🔥 Browsers ready: ${status.readyBrowsers}/${accountCount}\n` +
              `⏳ Waiting for OID...`
            );
          });
        },
        onExamWithOid: async (exam) => {
          const session = this.activeMonitoringSessions.get(scheduleId);
          if (!session || session.status === "paused") {
            console.log(`⏸️ ${schedule.name} paused, skipping`);
            return;
          }

          session.status = "processing";
          
          // CRITICAL OPTIMIZATION: INSTANT MULTI-BROWSER LAUNCH
          const oidDetectionTime = Date.now();
          console.log(`⚡⚡⚡ OID FOUND: ${exam.oid} - INSTANT PARALLEL LAUNCH!`);

          const status = browserPool.getStatus();

          // Check if browsers are ready
          if (status.readyBrowsers === 0) {
            console.warn(`⚠️ NO BROWSERS READY - Waiting for warmup...`);
            
            // Wait briefly for browsers to be ready (max 5 seconds)
            let waitTime = 0;
            while (browserPool.getReadyCount() === 0 && waitTime < 5000) {
              await new Promise(resolve => setTimeout(resolve, 100));
              waitTime += 100;
            }
            
            if (browserPool.getReadyCount() === 0) {
              console.error(`❌ CRITICAL: No browsers ready after ${waitTime}ms wait`);
            }
          }

          const readyCount = browserPool.getReadyCount();
          console.log(`🚀 LAUNCHING ${readyCount} BROWSERS SIMULTANEOUSLY!`);

          // Non-blocking user notification
          setImmediate(() => {
            this.sendLogToUser(
              user.telegramId,
              `⚡⚡⚡ **OID FOUND - INSTANT LAUNCH!**\n` +
              `📋 Schedule: ${schedule.name}\n` +
              `🆔 OID: ${exam.oid}\n` +
              `🔥 Launching ${readyCount} browsers NOW!\n` +
              `⚡ All accounts attacking simultaneously!`
            );
          });

          try {
            if (exam.oid) {
              // CRITICAL: Launch all browsers instantly
              const launchStartTime = Date.now();
              
              // Use the ultra-fast parallel launcher
              await runAllAccountsWithPrewarmedBrowsers(exam.oid, schedule.id);
              
              const totalLaunchTime = Date.now() - launchStartTime;
              const totalResponseTime = Date.now() - oidDetectionTime;
              
              console.log(`⚡ PERFORMANCE METRICS:`);
              console.log(`  - OID Detection → Launch: ${totalResponseTime}ms`);
              console.log(`  - Browser Launch Time: ${totalLaunchTime}ms`);
              console.log(`  - Browsers Launched: ${readyCount}`);

              await Schedule.findByIdAndUpdate(scheduleId, {
                completed: true,
                status: "success",
                lastRun: new Date(),
              });
            }
          } catch (automationError) {
            console.error(`❌ Automation failed:`, automationError);
            await this.handleScheduleFailure(
              scheduleId,
              automationError,
              user.telegramId
            );
          }

          this.activeMonitoringSessions.delete(scheduleId);
        },
        onTimeout: async () => {
          console.log(`⏰ [${schedule.name}] Timeout - no exam found`);
          await browserPool.closeAllBrowsers();
          await this.handleScheduleFailure(
            scheduleId,
            "No exam found within 30 minutes",
            user.telegramId
          );
        },
        stopOnFirstOid: true,
      });
    } catch (error) {
      console.error(`❌ Failed polling ${schedule.name}:`, error);
      await browserPool.closeAllBrowsers();
      this.activeMonitoringSessions.delete(scheduleId);
      await this.handleScheduleFailure(scheduleId, error, user.telegramId);
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

    const session = this.activeMonitoringSessions.get(scheduleId);
    const retryCount = session?.retryCount || (schedule as any).retryCount || 0;
    const maxRetries = session?.maxRetries || (schedule as any).maxRetries || 5;

    const errorMessage =
      (error as any).message || error.toString() || "Unknown error";

    if (retryCount < maxRetries) {
      await Schedule.findByIdAndUpdate(scheduleId, {
        status: "failed",
        monitoringStarted: false,
        lastError: errorMessage,
        lastRun: new Date(),
        retryCount: retryCount,
      });

      await this.sendLogToUser(
        telegramId,
        `⚠️ **Attempt Failed - Will Retry**\n` +
        `📋 Schedule: ${schedule.name}\n` +
        `❌ Error: ${errorMessage}\n` +
        `🔄 Retry ${retryCount + 1}/${maxRetries}\n\n` +
        `⏰ Auto-retry in 2 minutes\n` +
        `Or use /retry_${scheduleId} now`
      );

      this.activeMonitoringSessions.delete(scheduleId);
    } else {
      await Schedule.findByIdAndUpdate(scheduleId, {
        completed: true,
        status: "failed",
        lastError: `Max retries (${maxRetries}) reached: ${errorMessage}`,
        lastRun: new Date(),
      });

      await this.sendLogToUser(
        telegramId,
        `❌ **Schedule Failed - Max Retries**\n` +
        `📋 Schedule: ${schedule.name}\n` +
        `🚨 Error: ${errorMessage}\n` +
        `🔄 Attempts: ${retryCount}/${maxRetries}`
      );

      this.activeMonitoringSessions.delete(scheduleId);
    }
  }

  private async checkForAutomaticRetries(): Promise<void> {
    try {
      const readyForRetry = await Schedule.find({
        completed: false,
        status: "failed",
        $expr: { $lt: ["$retryCount", "$maxRetries"] },
      }).populate("createdBy");

      if (readyForRetry.length > 0) {
        console.log(
          `🔄 Found ${readyForRetry.length} schedules for auto-retry`
        );
      }

      for (const schedule of readyForRetry) {
        try {
          if (schedule.lastAttemptTime) {
            const timeSince = Date.now() - schedule.lastAttemptTime.getTime();
            const minWait = 2 * 60 * 1000;

            if (timeSince < minWait) {
              continue;
            }
          }

          if (this.activeMonitoringSessions.has(schedule.id.toString())) {
            continue;
          }

          console.log(`🔄 Auto-retrying: ${schedule.name}`);

          const user = schedule.createdBy as any;
          if (user?.telegramId) {
            await this.sendLogToUser(
              user.telegramId,
              `🔄 **Auto-Retry Starting**\n` +
              `📋 ${schedule.name}\n` +
              `🔄 Attempt ${(schedule.retryCount || 0) + 1}/${schedule.maxRetries || 5}`
            );
          }

          await this.startMonitoringForSchedule(schedule, true);
        } catch (error) {
          console.error(`❌ Auto-retry failed for ${schedule.name}:`, error);
        }
      }
    } catch (error) {
      console.error("❌ Error checking auto-retries:", error);
    }
  }

  async retrySchedule(scheduleId: string): Promise<void> {
    try {
      const schedule = await Schedule.findById(scheduleId).populate(
        "createdBy"
      );
      if (!schedule) {
        throw new Error(`Schedule ${scheduleId} not found`);
      }

      const retryCount = (schedule as any).retryCount || 0;
      const maxRetries = (schedule as any).maxRetries || 5;

      if (retryCount >= maxRetries) {
        throw new Error(`Max retries (${maxRetries}) reached`);
      }

      await Schedule.findByIdAndUpdate(scheduleId, {
        status: "pending",
        monitoringStarted: false,
        lastError: null,
      });

      if (this.activeMonitoringSessions.has(scheduleId)) {
        this.activeMonitoringSessions.delete(scheduleId);
        await examMonitor.stopPolling();
      }

      await this.startMonitoringForSchedule(schedule, true);
      console.log(`✅ Manual retry initiated for ${scheduleId}`);
    } catch (error) {
      console.error(`❌ Manual retry failed for ${scheduleId}:`, error);
      throw error;
    }
  }

  async pauseSchedule(scheduleId: string): Promise<void> {
    const session = this.activeMonitoringSessions.get(scheduleId);
    if (session) {
      session.status = "paused";
    }

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
      throw new Error("Schedule not paused");
    }

    await Schedule.findByIdAndUpdate(scheduleId, {
      status: "pending",
      monitoringStarted: false,
    });

    await this.startMonitoringForSchedule(schedule, false);
  }

  async stopSchedule(scheduleId: string): Promise<void> {
    const session = this.activeMonitoringSessions.get(scheduleId);
    if (session) {
      this.activeMonitoringSessions.delete(scheduleId);
    }

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
      console.error(`❌ Failed to send to ${telegramId}:`, error);
    }
  }

  private async cleanupCompletedSessions(): Promise<void> {
    const now = new Date();
    const expiredSessions: string[] = [];

    for (const [
      scheduleId,
      session,
    ] of this.activeMonitoringSessions.entries()) {
      const expiryTime = new Date(
        session.targetTime.getTime() + 30 * 60 * 1000
      );

      if (now > expiryTime && session.status !== "processing") {
        expiredSessions.push(scheduleId);
      }
    }

    for (const scheduleId of expiredSessions) {
      this.activeMonitoringSessions.delete(scheduleId);
      await this.handleScheduleFailure(scheduleId, "Session expired", "");
    }
  }

  getStatus(): any {
    const now = new Date();
    const sessions = Array.from(this.activeMonitoringSessions.values()).map(
      (session) => ({
        scheduleId: session.scheduleId,
        targetTime: session.targetTime.toLocaleString(),
        startedAt: session.startedAt.toLocaleString(),
        runningFor: `${Math.round(
          (now.getTime() - session.startedAt.getTime()) / 1000
        )}s`,
        status: session.status,
        retryCount: session.retryCount,
        maxRetries: session.maxRetries,
        browsersPrewarmed: session.browsersPrewarmed || false,
      })
    );

    return {
      isRunning: this.isRunning,
      activeSessions: this.activeMonitoringSessions.size,
      sessions,
    };
  }

  async stopAllMonitoring(): Promise<void> {
    console.log(`🛑 Stopping ${this.activeMonitoringSessions.size} sessions`);
    examMonitor.destroy();
    await browserPool.closeAllBrowsers();
    this.activeMonitoringSessions.clear();
  }

  async triggerSchedule(scheduleId: string): Promise<void> {
    const schedule = await Schedule.findById(scheduleId).populate("createdBy");
    if (!schedule || schedule.completed) {
      throw new Error("Schedule not found or completed");
    }

    await Schedule.findByIdAndUpdate(scheduleId, {
      status: "pending",
      monitoringStarted: false,
      lastError: null,
    });

    await this.startMonitoringForSchedule(schedule);
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

process.on("SIGINT", async () => {
  console.log("\n🛑 SIGINT - shutting down...");
  examScheduler.stop();
  await examScheduler.stopAllMonitoring();
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 SIGTERM - shutting down...");
  examScheduler.stop();
  await examScheduler.stopAllMonitoring();
});

export { examScheduler, ExamScheduler };