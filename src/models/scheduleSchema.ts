// Updated scheduleSchema.ts with retry support

import mongoose, { Document, Schema, Model } from "mongoose";

export interface ISchedule extends Document {
  name: string;
  runAt: Date;
  createdBy: mongoose.Types.ObjectId;
  completed: boolean;
  status?: "pending" | "running" | "paused" | "failed" | "success" | "stopped";
  lastRun?: Date;
  lastError?: string;
  monitoringStarted?: boolean;
  retryCount?: number;
  maxRetries?: number;
  lastAttemptTime?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  // Method signatures
  incrementRetry(): Promise<ISchedule>;
  resetRetries(): Promise<ISchedule>;
}

// Interface for static methods
interface IScheduleModel extends Model<ISchedule> {
  findReadyForRetry(minMinutesBetweenRetries?: number): Promise<ISchedule[]>;
}

const scheduleSchema = new Schema<ISchedule, IScheduleModel>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    runAt: {
      type: Date,
      required: true,
      index: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    completed: {
      type: Boolean,
      default: false,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "running", "paused", "failed", "success", "stopped"],
      default: "pending",
      index: true,
    },
    lastRun: {
      type: Date,
    },
    lastError: {
      type: String,
    },
    monitoringStarted: {
      type: Boolean,
      default: false,
      index: true,
    },
    retryCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    maxRetries: {
      type: Number,
      default: 5,
      min: 0,
      max: 20,
    },
    lastAttemptTime: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for efficient queries
scheduleSchema.index({ createdBy: 1, completed: 1 });
scheduleSchema.index({ runAt: 1, completed: 1, status: 1 });
scheduleSchema.index({ monitoringStarted: 1, completed: 1 });

// Virtual for checking if retries are available
scheduleSchema.virtual("canRetry").get(function (this: ISchedule) {
  return (this.retryCount || 0) < (this.maxRetries || 5) && !this.completed;
});

// Method to increment retry count
scheduleSchema.methods.incrementRetry = async function (
  this: ISchedule
): Promise<ISchedule> {
  this.retryCount = (this.retryCount || 0) + 1;
  this.lastAttemptTime = new Date();
  return await this.save();
};

// Method to reset retry count
scheduleSchema.methods.resetRetries = async function (
  this: ISchedule
): Promise<ISchedule> {
  this.retryCount = 0;
  this.lastAttemptTime = undefined;
  this.lastError = undefined;
  return await this.save();
};

// Static method to find schedules ready for retry
scheduleSchema.statics.findReadyForRetry = function (
  this: IScheduleModel,
  minMinutesBetweenRetries: number = 2
): Promise<ISchedule[]> {
  const cutoffTime = new Date(
    Date.now() - minMinutesBetweenRetries * 60 * 1000
  );

  return this.find({
    completed: false,
    status: "failed",
    $expr: { $lt: ["$retryCount", "$maxRetries"] },
    $or: [
      { lastAttemptTime: { $exists: false } },
      { lastAttemptTime: { $lt: cutoffTime } },
    ],
  }).populate("createdBy") as Promise<ISchedule[]>;
};

const Schedule = mongoose.model<ISchedule, IScheduleModel>(
  "Schedule",
  scheduleSchema
);

export default Schedule;
