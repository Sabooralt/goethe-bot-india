import dotenv from "dotenv";
import mongoose from "mongoose";
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import User from "./models/userSchema";
import Account from "./models/accountSchema";
import Schedule from "./models/scheduleSchema";
import { examScheduler } from "./schedulers/scheduler";
import { DateTime } from "luxon";

dotenv.config();

interface States {
  IDLE: string;
  ADDING_ACCOUNT: string;
  REMOVING_ACCOUNT: string;
  TOGGLING_ACCOUNT: string;
  ADDING_PERSONAL_DETAILS: string;
  SELECTING_MODULES: string;
  SETTING_SCHEDULE: string;
  SETTING_SCHEDULE_TIME: string;
  SETTING_SCHEDULE_DATE: string;
  VIEWING_SCHEDULES: string;
  REMOVING_SCHEDULE: string;
}

const token = process.env.TELEGRAM_TOKEN || "";
const mongoUri = process.env.MONGO_URI || "";
const PORT = process.env.HEALTH_CHECK_PORT || 3001;

let schedulerRunning = false;

const app = express();
app.use(express.json());

app.get("/status/scheduler", (req, res) => {
  try {
    const status = examScheduler.getStatus();
    res.json({
      success: true,
      scheduler: status,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof Error) {
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(500).json({
        success: false,
        error: String(error), // fallback
        timestamp: new Date().toISOString(),
      });
    }
  }
});

// Optional: Emergency stop endpoint (useful for debugging)
app.post("/admin/scheduler/stop", async (req, res) => {
  try {
    await examScheduler.stopAllMonitoring();
    examScheduler.stop();
    schedulerRunning = false;

    res.json({
      success: true,
      message: "Scheduler stopped successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: (error as any).message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Optional: Manual trigger endpoint (useful for testing)
app.post("/admin/scheduler/trigger/:scheduleId", async (req, res) => {
  try {
    const { scheduleId } = req.params;
    await examScheduler.triggerSchedule(scheduleId);

    res.json({
      success: true,
      message: `Schedule ${scheduleId} triggered successfully`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: (error as any).message,
      timestamp: new Date().toISOString(),
    });
  }
});

const userStates = new Map();

const STATES: States = {
  IDLE: "idle",
  ADDING_ACCOUNT: "adding_account",
  REMOVING_ACCOUNT: "removing_account",
  TOGGLING_ACCOUNT: "toggling_account",
  ADDING_PERSONAL_DETAILS: "adding_personal_details",
  SELECTING_MODULES: "selecting_modules",
  SETTING_SCHEDULE: "setting_schedule",
  SETTING_SCHEDULE_TIME: "setting_schedule_time",
  SETTING_SCHEDULE_DATE: "setting_schedule_date",
  VIEWING_SCHEDULES: "viewing_schedules",
  REMOVING_SCHEDULE: "removing_schedule",
};

export const bot = new TelegramBot(token, { polling: true });

(async () => {
  async function start() {
    try {
      // Connect to MongoDB
      await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 20000,
        socketTimeoutMS: 45000,
      });

      // Start the web server
      app.listen(PORT, () => {
        console.log(`🚀 Server is running on http://localhost:${PORT}`);
        console.log(
          `🩺 Health endpoint: http://localhost:${PORT}/status/health`
        );
      });

      // Start the exam scheduler (only once)
      if (schedulerRunning) {
        console.log("⚠️ Scheduler already running, skipping startup");
        return;
      }

      schedulerRunning = true;
      examScheduler.start();
    } catch (err) {
      console.error("❌ Startup error:", err);
      schedulerRunning = false;
      throw err;
    }
  }

  start();

  const mainMenuOptions = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Add an account", callback_data: "add_account" },
          { text: "View added accounts", callback_data: "view_accounts" },
        ],
        [
          { text: "Remove an account", callback_data: "remove_account" },
          { text: "Toggle account status", callback_data: "toggle_account" },
        ],
        [
          { text: "⏰ Schedule scraping", callback_data: "schedule_scraping" },
          { text: "📅 View schedules", callback_data: "view_schedules" },
        ],
        [{ text: "🗑️ Remove schedule", callback_data: "remove_schedule" }],
        [{ text: "Cancel", callback_data: "cancel" }],
      ],
    },
  };

  // Helper functions
  const getUserState = (userId: string) => {
    if (!userId) return { state: STATES.IDLE };
    return userStates.get(userId) || { state: STATES.IDLE };
  };

  const setUserState = (userId: string, state: string, data = {}) => {
    const newState = {
      ...data,
      state,
    };
    userStates.set(userId, newState);
  };

  const clearUserState = (userId: string) => {
    userStates.delete(userId);
  };

  const isValidEmail = (email: string) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const showMainMenu = (chatId: number, message = "Choose an option:") => {
    return bot.sendMessage(chatId, message, mainMenuOptions);
  };

  // Command handlers
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id?.toString();
    const username = msg.from?.username;

    if (!userId) return;

    clearUserState(userId);

    try {
      let user = await User.findOne({ telegramId: userId });

      if (!user) {
        user = new User({
          telegramId: userId,
          username: username || `user_${userId}`,
        });
        await user.save();
        showMainMenu(
          chatId,
          `Welcome ${
            username || "User"
          }! Your account has been created.\n\nChoose an option:`
        );
      } else {
        showMainMenu(
          chatId,
          `Welcome back, ${username || "User"}!\n\nChoose an option:`
        );
      }
    } catch (error) {
      console.error("Error in /start command:", error);
      await bot.sendMessage(
        chatId,
        "Sorry, there was an error. Please try again."
      );
    }
  });

  bot.onText(/\/cancel/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id?.toString() || "";
    clearUserState(userId);
    showMainMenu(chatId, "Operation cancelled. Choose an option:");
  });

  bot.onText(/\/state/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id?.toString() || "";
    const state = getUserState(userId);
    bot.sendMessage(
      chatId,
      `Current state:\n${JSON.stringify(state, null, 2)}`
    );
  });

  // Handle delete schedule commands
  bot.onText(/\/delete_(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id?.toString();
    const scheduleId = match?.[1];

    if (!userId || !scheduleId) return;

    await handleDeleteSchedule(chatId, userId, scheduleId);
  });

  // Message handler with state management
  bot.on("message", async (msg) => {
    if (msg.text && msg.text.startsWith("/")) return;

    const chatId = msg.chat.id;
    const userId = msg.from?.id?.toString();
    if (!userId) return;

    const userState = getUserState(userId);

    try {
      switch (userState.state) {
        case STATES.ADDING_ACCOUNT:
          await handleAddAccountMessage(chatId, userId, msg.text);
          break;
        case STATES.ADDING_PERSONAL_DETAILS:
          await handlePersonalDetailsMessage(
            chatId,
            userId,
            msg.text,
            userState
          );
          break;
        case STATES.SELECTING_MODULES:
          await handleModuleSelectionMessage(
            chatId,
            userId,
            msg.text,
            userState
          );
          break;
        case STATES.REMOVING_ACCOUNT:
          await handleRemoveAccountMessage(chatId, userId, msg.text);
          break;
        case STATES.TOGGLING_ACCOUNT:
          await handleToggleAccountMessage(chatId, userId, msg.text);
          break;
        case STATES.SETTING_SCHEDULE:
          await handleScheduleCreation(chatId, userId, msg.text);
          break;
        case STATES.REMOVING_SCHEDULE:
          await handleRemoveScheduleMessage(chatId, userId, msg.text);
          break;
        default:
          showMainMenu(chatId, "Please use the menu buttons to navigate:");
      }
    } catch (error) {
      console.error("Error handling message:", error);
      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        "Sorry, there was an error. Please try again."
      );
      showMainMenu(chatId);
    }
  });

  // Callback query handler
  bot.on("callback_query", async (callbackQuery) => {
    const chatId = callbackQuery.message?.chat.id;
    const userId = callbackQuery.from.id.toString();
    const data = callbackQuery.data;
    const messageId = callbackQuery.message?.message_id;

    if (!chatId || !messageId) return;

    await bot.answerCallbackQuery(callbackQuery.id);

    try {
      if (data === "cancel") {
        clearUserState(userId);
        showMainMenu(chatId, "Operation cancelled. Choose an option:");
        return;
      }

      const userState = getUserState(userId);
      switch (userState.state) {
        case STATES.IDLE:
          await handleMainMenuCallback(chatId, userId, data, messageId);
          break;
        case STATES.SELECTING_MODULES:
          await handleModuleCallback(chatId, userId, data, userState);
          break;
        default:
          showMainMenu(chatId, "Please use the menu to navigate:");
      }
    } catch (error) {
      console.error("Error handling callback query:", error);
      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        "❌ Sorry, there was an error. Please try again."
      );
      showMainMenu(chatId);
    }
  });

  // Main menu callback handler
  const handleMainMenuCallback = async (
    chatId: number,
    userId: string,
    data: string | undefined,
    messageId: number
  ) => {
    switch (data) {
      case "add_account":
        await startAddAccount(chatId, userId, messageId);
        break;
      case "view_accounts":
        await viewAccounts(chatId, userId, messageId);
        break;
      case "remove_account":
        await startRemoveAccount(chatId, userId, messageId);
        break;
      case "toggle_account":
        await startToggleAccount(chatId, userId, messageId);
        break;
      case "schedule_scraping":
        await startScheduleScraping(chatId, userId, messageId);
        break;
      case "view_schedules":
        await viewSchedules(chatId, userId, messageId);
        break;
      case "remove_schedule":
        await startRemoveSchedule(chatId, userId, messageId);
        break;
      default:
        showMainMenu(chatId);
    }
  };

  // Add account functions
  const startAddAccount = async (
    chatId: number,
    userId: string,
    messageId: number
  ) => {
    setUserState(userId, STATES.ADDING_ACCOUNT);

    if (messageId) {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        {
          chat_id: chatId,
          message_id: messageId,
        }
      );
    }

    const cancelOptions = {
      reply_markup: {
        inline_keyboard: [[{ text: "Cancel", callback_data: "cancel" }]],
      },
    };

    await bot.sendMessage(
      chatId,
      `Please provide your account details in the following format:\n\nfirst_name:last_name:email:password\n\nExample:\nJohn:Doe:john.doe@example.com:welcome123\n\nOr click Cancel to return to the main menu.`,
      cancelOptions
    );
  };

  const handleAddAccountMessage = async (
    chatId: number,
    userId: string,
    text: string | undefined
  ) => {
    if (!text) return;

    const entry = text.trim();
    const fields = entry.split(":");

    if (fields.length !== 4) {
      await bot.sendMessage(
        chatId,
        "Invalid format. Please ensure your entry follows the specified format:\nfirst_name:last_name:email:password"
      );
      return;
    }

    const [firstName, lastName, email, password] = fields.map((field) =>
      field.trim()
    );

    if (!firstName || !lastName || !password) {
      await bot.sendMessage(
        chatId,
        "All fields are required. Please provide: first_name:last_name:email:password"
      );
      return;
    }
    if (!isValidEmail(email)) {
      await bot.sendMessage(
        chatId,
        "Invalid email format. Please provide a valid email address."
      );
      return;
    }

    try {
      const existingAccount = await Account.findOne({ email });
      if (existingAccount) {
        await bot.sendMessage(
          chatId,
          "An account with this email already exists. Please use a different email."
        );
        return;
      }

      // Store basic account data and move to personal details
      setUserState(userId, STATES.ADDING_PERSONAL_DETAILS, {
        firstName,
        lastName,
        email,
        password,
      });

      await bot.sendMessage(
        chatId,
        `Great! Now please provide your personal details in the following format:\n\n` +
          `day:month:year:street:city:postalCode:houseNo:countryCode:phoneNumber\n\n` +
          `Example:\n15:03:1990:Main Street:New York:10001:123A:+1:5551234567\n\n` +
          `Or click Cancel to return to the main menu.`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: "Cancel", callback_data: "cancel" }]],
          },
        }
      );
    } catch (error) {
      console.error("Error checking existing account:", error);
      await bot.sendMessage(chatId, "❌ There was an error. Please try again.");
    }
  };

  const handlePersonalDetailsMessage = async (
    chatId: number,
    userId: string,
    text: string | undefined,
    userState: any
  ) => {
    if (!text) return;

    const entry = text.trim();
    const fields = entry.split(":");

    if (fields.length !== 9) {
      await bot.sendMessage(
        chatId,
        "Invalid format. Please ensure your entry follows the specified format:\n" +
          "day:month:year:street:city:postalCode:houseNo:countryCode:phoneNumber"
      );
      return;
    }

    const [
      day,
      month,
      year,
      street,
      city,
      postalCode,
      houseNo,
      countryCode,
      phoneNumber,
    ] = fields.map((field) => field.trim());

    // Validate date
    const dayNum = parseInt(day);
    const monthNum = parseInt(month);
    const yearNum = parseInt(year);

    if (
      isNaN(dayNum) ||
      isNaN(monthNum) ||
      isNaN(yearNum) ||
      dayNum < 1 ||
      dayNum > 31 ||
      monthNum < 1 ||
      monthNum > 12 ||
      yearNum < 1900 ||
      yearNum > 2020
    ) {
      await bot.sendMessage(
        chatId,
        "Invalid date. Please provide valid day (1-31), month (1-12), and year (1900-2020)."
      );
      return;
    }

    if (
      !street ||
      !city ||
      !postalCode ||
      !houseNo ||
      !countryCode ||
      !phoneNumber
    ) {
      await bot.sendMessage(
        chatId,
        "All fields are required. Please provide all personal details."
      );
      return;
    }

    // Move to module selection with all data
    setUserState(userId, STATES.SELECTING_MODULES, {
      ...userState,
      personalDetails: {
        day: dayNum,
        month: monthNum,
        year: yearNum,
        street,
        city,
        postalCode,
        houseNo,
        countryCode,
        phoneNumber,
      },
      modules: {
        read: false,
        hear: false,
        write: false,
        speak: false,
      },
    });

    await showModuleSelection(chatId, userId);
  };

  const showModuleSelection = async (chatId: number, userId: string) => {
    const userState = getUserState(userId);
    const modules = userState.modules || {
      read: false,
      hear: false,
      write: false,
      speak: false,
    };

    const moduleButtons = [
      [
        {
          text: `📖 Read ${modules.read ? "✅" : "❌"}`,
          callback_data: "toggle_read",
        },
        {
          text: `👂 Hear ${modules.hear ? "✅" : "❌"}`,
          callback_data: "toggle_hear",
        },
      ],
      [
        {
          text: `✏️ Write ${modules.write ? "✅" : "❌"}`,
          callback_data: "toggle_write",
        },
        {
          text: `🗣️ Speak ${modules.speak ? "✅" : "❌"}`,
          callback_data: "toggle_speak",
        },
      ],
      [
        { text: "✅ Confirm Selection", callback_data: "confirm_modules" },
        { text: "Cancel", callback_data: "cancel" },
      ],
    ];

    const selectedCount = Object.values(modules).filter(Boolean).length;
    const moduleStatus =
      selectedCount > 0
        ? `\n\n🎯 Selected modules: ${selectedCount}/4`
        : "\n\n⚠️ No modules selected yet";

    await bot.sendMessage(
      chatId,
      `🔧 **Module Selection**\n\nPlease select the modules you want to enable for this account:${moduleStatus}\n\n` +
        `📖 **Read** - Enable reading capabilities\n` +
        `👂 **Hear** - Enable hearing capabilities\n` +
        `✏️ **Write** - Enable writing capabilities\n` +
        `🗣️ **Speak** - Enable speaking capabilities\n\n` +
        `Click the modules to toggle them on/off, then click "Confirm Selection" when ready.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: moduleButtons,
        },
      }
    );
  };

  const handleModuleCallback = async (
    chatId: number,
    userId: string,
    data: string | undefined,
    userState: any
  ) => {
    if (!data) return;

    const modules = { ...userState.modules };

    switch (data) {
      case "toggle_read":
        modules.read = !modules.read;
        break;
      case "toggle_hear":
        modules.hear = !modules.hear;
        break;
      case "toggle_write":
        modules.write = !modules.write;
        break;
      case "toggle_speak":
        modules.speak = !modules.speak;
        break;
      case "confirm_modules":
        await createAccountWithModules(chatId, userId, userState);
        return;
      default:
        return;
    }

    // Update state with new module selection
    setUserState(userId, STATES.SELECTING_MODULES, {
      ...userState,
      modules,
    });

    // Refresh the module selection display
    await showModuleSelection(chatId, userId);
  };

  const handleModuleSelectionMessage = async (
    chatId: number,
    userId: string,
    text: string | undefined,
    userState: any
  ) => {
    // Ignore text messages in module selection state, user should use buttons
    await bot.sendMessage(
      chatId,
      "Please use the buttons above to select modules, or click Cancel to return to the main menu."
    );
  };

  const createAccountWithModules = async (
    chatId: number,
    userId: string,
    userState: any
  ) => {
    try {
      // Find or create user
      let user = await User.findOne({ telegramId: userId });
      if (!user) {
        user = await User.create({ telegramId: userId });
      }

      const { personalDetails, modules } = userState;

      // Create the account with modules
      const newAccount = await Account.create({
        user: user._id,
        email: userState.email,
        password: userState.password,
        firstName: userState.firstName,
        lastName: userState.lastName,
        status: true,
        modules: {
          read: modules.read,
          hear: modules.hear,
          write: modules.write,
          speak: modules.speak,
        },
        details: {
          dob: {
            day: personalDetails.day,
            month: personalDetails.month,
            year: personalDetails.year,
          },
          address: {
            street: personalDetails.street,
            city: personalDetails.city,
            postalCode: personalDetails.postalCode,
            houseNo: personalDetails.houseNo,
          },
          phone: {
            countryCode: personalDetails.countryCode,
            number: personalDetails.phoneNumber,
          },
        },
      });

      clearUserState(userId);

      const enabledModules = Object.entries(modules)
        .filter(([_, enabled]) => enabled)
        .map(([module, _]) => module)
        .join(", ");

      const modulesList = enabledModules || "None";

      await bot.sendMessage(
        chatId,
        `✅ Successfully created account for ${userState.firstName} ${userState.lastName}!\n\n` +
          `📧 Email: ${userState.email}\n` +
          `🎂 DOB: ${personalDetails.day}/${personalDetails.month}/${personalDetails.year}\n` +
          `🏠 Address: ${personalDetails.houseNo} ${personalDetails.street}, ${personalDetails.city}, ${personalDetails.postalCode}\n` +
          `📞 Phone: ${personalDetails.countryCode} ${personalDetails.phoneNumber}\n` +
          `🔧 Enabled Modules: ${modulesList}`
      );

      showMainMenu(chatId, "What would you like to do next?");
    } catch (error) {
      console.error("Error saving account:", error);
      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        "❌ There was an error saving your account. Please try again."
      );
      showMainMenu(chatId);
    }
  };

  function escapeMarkdownV2(text: string): string {
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
  }

  // View accounts function (updated to show modules)
  const viewAccounts = async (
    chatId: number,
    userId: string,
    messageId: number
  ) => {
    try {
      if (messageId) {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          {
            chat_id: chatId,
            message_id: messageId,
          }
        );
      }
      await bot.sendMessage(
        chatId,
        "🔍 Getting your accounts from the database, please wait..."
      );

      const user = await User.findOne({ telegramId: userId });
      if (!user) {
        await bot.sendMessage(
          chatId,
          "❌ User not found. Please start with /start command."
        );
        return;
      }

      const accounts = await Account.find({ user: user._id });

      if (accounts && accounts.length > 0) {
        const accountList = accounts
          .map((account, index) => {
            const dob = account.details?.dob;
            const address = account.details?.address;
            const phone = account.details?.phone;

            const enabledModules =
              Object.entries(account.modules || {})
                .filter(([_, enabled]) => enabled)
                .map(([module, _]) => escapeMarkdownV2(module)) // ✅ escape here
                .join(", ") || "None";

            return (
              `${index + 1}. **ID:** \`${account._id}\`\n` +
              `   👤 **Name:** ${account.firstName} ${account.lastName}\n` +
              `   📧 **Email:** ${account.email}\n` +
              `   🎂 **DOB:** ${dob?.day ?? "?"}/${dob?.month ?? "?"}/${
                dob?.year ?? "?"
              }\n` +
              `   🏠 **Address:** ${address?.houseNo ?? ""} ${
                address?.street ?? ""
              }, ${address?.city ?? ""}\n` +
              `   📞 **Phone:** ${phone?.countryCode ?? ""} ${
                phone?.number ?? ""
              }\n` +
              `   🔧 **Modules:** ${enabledModules}\n`
            );
          })
          .join("\n");

        await bot.sendMessage(
          chatId,
          `📋 **Your Accounts:**\n\n${accountList}`,
          {
            parse_mode: "Markdown",
          }
        );
      } else {
        await bot.sendMessage(chatId, "❌ You have no added accounts.");
      }

      await showMainMenu(chatId, "What would you like to do next?");
    } catch (error) {
      console.error("Error viewing accounts:", error);
      await bot.sendMessage(
        chatId,
        "❌ There was an error retrieving your accounts. Please try again."
      );
      showMainMenu(chatId);
    }
  };

  // Remove account functions
  const startRemoveAccount = async (
    chatId: number,
    userId: string,
    messageId: number
  ) => {
    setUserState(userId, STATES.REMOVING_ACCOUNT);

    if (messageId) {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        {
          chat_id: chatId,
          message_id: messageId,
        }
      );
    }

    const cancelOptions = {
      reply_markup: {
        inline_keyboard: [[{ text: "Cancel", callback_data: "cancel" }]],
      },
    };

    await bot.sendMessage(
      chatId,
      "🗑️ Please provide the ID of the account you wish to remove:\n\nOr click Cancel to return to the main menu.",
      cancelOptions
    );
  };

  const handleRemoveAccountMessage = async (
    chatId: number,
    userId: string,
    text: string | undefined
  ) => {
    if (!text) return;

    const accountId = text.trim();

    if (!accountId) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid input. Please provide a valid account ID."
      );
      return;
    }

    try {
      const user = await User.findOne({ telegramId: userId });

      if (!user) {
        clearUserState(userId);
        await bot.sendMessage(chatId, "❌ User not found. Please try again.");
        showMainMenu(chatId);
        return;
      }

      const account = await Account.findOne({
        _id: accountId,
        user: user._id,
      });

      if (!account) {
        await bot.sendMessage(
          chatId,
          "❌ Account not found or it doesn't belong to you. Please check the ID and try again."
        );
        return;
      }

      await Account.deleteOne({ _id: accountId });

      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        `✅ Successfully removed account: ${account.email}`
      );
      showMainMenu(chatId, "What would you like to do next?");
    } catch (error) {
      console.error("Error removing account:", error);
      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        "❌ There was an error removing the account. Please try again."
      );
      showMainMenu(chatId);
    }
  };

  const startToggleAccount = async (
    chatId: number,
    userId: string,
    messageId: number
  ) => {
    setUserState(userId, STATES.TOGGLING_ACCOUNT);

    if (messageId) {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        {
          chat_id: chatId,
          message_id: messageId,
        }
      );
    }

    const cancelOptions = {
      reply_markup: {
        inline_keyboard: [[{ text: "Cancel", callback_data: "cancel" }]],
      },
    };

    await bot.sendMessage(
      chatId,
      "⚡ Please provide the ID of the account you wish to toggle (enable/disable):\n\nOr click Cancel to return to the main menu.",
      cancelOptions
    );
  };

  const handleToggleAccountMessage = async (
    chatId: number,
    userId: string,
    text: string | undefined
  ) => {
    if (!text) return;

    const accountId = text.trim();

    if (!accountId) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid input. Please provide a valid account ID."
      );
      return;
    }

    try {
      const user = await User.findOne({ telegramId: userId });

      if (!user) {
        clearUserState(userId);
        await bot.sendMessage(chatId, "❌ User not found. Please try again.");
        showMainMenu(chatId);
        return;
      }

      const account = await Account.findOne({
        _id: accountId,
        user: user._id,
      });

      if (!account) {
        await bot.sendMessage(
          chatId,
          "❌ Account not found or it doesn't belong to you. Please check the ID and try again."
        );
        return;
      }

      // Toggle the status field
      account.status = !account.status;
      await account.save();

      const statusText = account.status ? "🟢 enabled" : "🔴 disabled";
      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        `✅ Successfully ${statusText} the account: ${account.email}`
      );
      showMainMenu(chatId, "What would you like to do next?");
    } catch (error) {
      console.error("Error toggling account status:", error);
      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        "❌ There was an error toggling the account status. Please try again."
      );
      showMainMenu(chatId);
    }
  };

  // FIXED SCHEDULING FUNCTIONS

  const startScheduleScraping = async (
    chatId: number,
    userId: string,
    messageId: number
  ) => {
    setUserState(userId, STATES.SETTING_SCHEDULE);

    if (messageId) {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        {
          chat_id: chatId,
          message_id: messageId,
        }
      );
    }

    const cancelOptions = {
      reply_markup: {
        inline_keyboard: [[{ text: "Cancel", callback_data: "cancel" }]],
      },
    };

    await bot.sendMessage(
      chatId,
      "⏰ Please enter the schedule details in **UTC time** using this format:\n\n" +
        "YYYY-MM-DD HH:MM ScheduleName\n\n" +
        "Example:\n" +
        "2024-12-25 09:30 Christmas Booking (UTC)\n" +
        "2025-01-15 14:00 January Session (UTC)\n\n" +
        "Or click Cancel to return to the main menu.",
      cancelOptions
    );
  };

  const handleScheduleCreation = async (
    chatId: number,
    userId: string,
    text: string | undefined
  ) => {
    if (!text) return;

    const input = text.trim();
    const parts = input.split(" ");

    if (parts.length < 3) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid format. Please use: YYYY-MM-DD HH:MM ScheduleName"
      );
      return;
    }

    const datePart = parts[0];
    const timePart = parts[1];
    const nameParts = parts.slice(2);
    const scheduleName =
      nameParts.join(" ") || `Schedule ${new Date().toLocaleString()}`;

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(datePart)) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid date format. Please use YYYY-MM-DD (e.g., 2024-12-25)"
      );
      return;
    }

    // Validate time format
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(timePart)) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid time format. Please use HH:MM (e.g., 14:30)"
      );
      return;
    }

    // Combine date and time into UTC DateTime
    const datetimeStr = `${datePart}T${timePart}:00Z`; // Z = UTC
    const runAt = DateTime.fromISO(datetimeStr, { zone: "utc" });

    if (!runAt.isValid) {
      await bot.sendMessage(
        chatId,
        `❌ Invalid date/time: ${
          runAt.invalidExplanation || "Please check your input"
        }`
      );
      return;
    }

    if (runAt.toJSDate() <= new Date()) {
      await bot.sendMessage(
        chatId,
        "❌ Schedule time must be in the future. Please choose a later date/time."
      );
      return;
    }

    try {
      const user = await User.findOne({ telegramId: userId });
      if (!user) {
        clearUserState(userId);
        await bot.sendMessage(
          chatId,
          "❌ User not found. Please start with /start command."
        );
        showMainMenu(chatId);
        return;
      }

      const newSchedule = await Schedule.create({
        name: scheduleName,
        runAt: runAt.toJSDate(), // store as UTC
        createdBy: user._id,
        completed: false,
      });

      clearUserState(userId);

      // Confirm in UTC
      const displayTime = runAt.toUTC().toFormat("yyyy-MM-dd HH:mm 'UTC'");

      await bot.sendMessage(
        chatId,
        `✅ Schedule created successfully!\n\n` +
          `📝 Name: ${scheduleName}\n` +
          `⏰ Scheduled for: ${displayTime}\n` +
          `🆔 ID: ${newSchedule._id}\n\n` +
          `All active accounts will run automatically at this time.`
      );

      showMainMenu(chatId, "What would you like to do next?");
    } catch (error) {
      console.error("Schedule creation error:", error);
      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        "❌ Failed to create schedule. Please try again."
      );
      showMainMenu(chatId);
    }
  };

  const viewSchedules = async (
    chatId: number,
    userId: string,
    messageId: number
  ) => {
    try {
      if (messageId) {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          {
            chat_id: chatId,
            message_id: messageId,
          }
        );
      }
      await bot.sendMessage(chatId, "🔍 Fetching your schedules...");

      const user = await User.findOne({ telegramId: userId });
      if (!user) {
        await bot.sendMessage(
          chatId,
          "❌ User not found. Please start with /start command."
        );
        showMainMenu(chatId);
        return;
      }

      const schedules = await Schedule.find({
        createdBy: user._id,
        completed: false,
      }).sort({ runAt: 1 });

      if (schedules.length === 0) {
        await bot.sendMessage(chatId, "📅 You have no active schedules.");
        showMainMenu(chatId, "What would you like to do next?");
        return;
      }

      const scheduleList = schedules
        .map((schedule, index) => {
          const runTime = schedule.runAt.toLocaleString();
          const lastRun = schedule.lastRun
            ? schedule.lastRun.toLocaleString()
            : "Never";
          const lastError = schedule.lastError ? schedule.lastError : "None";
          return (
            `${index + 1}. **${schedule.name}**\n` +
            `   ⏰ **Runs at:** ${runTime}\n` +
            `   🆔 **ID:** \`${schedule._id}\`\n` +
            `   📝 **Status:** ${
              schedule.completed ? "Completed" : "Pending"
            }\n` +
            `   🔄 *Last Run:* ${lastRun}\n` +
            `   ⚠️ *Last Error:* ${lastError}\n` +
            `   📡 *Monitoring:* ${schedule.monitoringStarted ? "Yes" : "No"}`
          );
        })
        .join("\n\n");

      await bot.sendMessage(
        chatId,
        `📅 **Your Active Schedules:**\n\n${scheduleList}\n\n` +
          `Use "Remove schedule" from the menu to delete a schedule.`,
        { parse_mode: "Markdown" }
      );

      showMainMenu(chatId, "What would you like to do next?");
    } catch (error) {
      console.error("Error viewing schedules:", error);
      await bot.sendMessage(
        chatId,
        "❌ Failed to retrieve schedules. Please try again."
      );
      showMainMenu(chatId);
    }
  };

  const startRemoveSchedule = async (
    chatId: number,
    userId: string,
    messageId: number
  ) => {
    try {
      if (messageId) {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          {
            chat_id: chatId,
            message_id: messageId,
          }
        );
      }
      const user = await User.findOne({ telegramId: userId });
      if (!user) {
        await bot.sendMessage(
          chatId,
          "❌ User not found. Please start with /start command."
        );
        showMainMenu(chatId);
        return;
      }

      const schedules = await Schedule.find({
        createdBy: user._id,
        completed: false,
      }).sort({ runAt: 1 });

      if (schedules.length === 0) {
        await bot.sendMessage(
          chatId,
          "📅 You have no active schedules to remove."
        );
        showMainMenu(chatId, "What would you like to do next?");
        return;
      }

      setUserState(userId, STATES.REMOVING_SCHEDULE);

      const scheduleList = schedules
        .map((schedule, index) => {
          const runTime = schedule.runAt.toLocaleString();
          return `${index + 1}. ${schedule.name} (${runTime}) - ID: ${
            schedule._id
          }`;
        })
        .join("\n");

      const cancelOptions = {
        reply_markup: {
          inline_keyboard: [[{ text: "Cancel", callback_data: "cancel" }]],
        },
      };

      await bot.sendMessage(
        chatId,
        `🗑️ **Select a schedule to remove:**\n\n${scheduleList}\n\n` +
          `Please enter the **full ID** of the schedule you want to remove:`,
        cancelOptions
      );
    } catch (error) {
      console.error("Error starting remove schedule:", error);
      await bot.sendMessage(
        chatId,
        "❌ Failed to load schedules. Please try again."
      );
      showMainMenu(chatId);
    }
  };

  const handleRemoveScheduleMessage = async (
    chatId: number,
    userId: string,
    text: string | undefined
  ) => {
    if (!text) return;

    const scheduleId = text.trim();

    if (!scheduleId) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid input. Please provide a valid schedule ID."
      );
      return;
    }

    try {
      const user = await User.findOne({ telegramId: userId });
      if (!user) {
        clearUserState(userId);
        await bot.sendMessage(chatId, "❌ User not found. Please try again.");
        showMainMenu(chatId);
        return;
      }

      const schedule = await Schedule.findOne({
        _id: scheduleId,
        createdBy: user._id,
      });

      if (!schedule) {
        await bot.sendMessage(
          chatId,
          "❌ Schedule not found or it doesn't belong to you. Please check the ID and try again."
        );
        return;
      }

      await Schedule.deleteOne({ _id: scheduleId });

      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        `✅ Successfully removed schedule: "${schedule.name}"`
      );
      showMainMenu(chatId, "What would you like to do next?");
    } catch (error) {
      console.error("Error removing schedule:", error);
      clearUserState(userId);
      await bot.sendMessage(
        chatId,
        "❌ There was an error removing the schedule. Please try again."
      );
      showMainMenu(chatId);
    }
  };

  const handleDeleteSchedule = async (
    chatId: number,
    userId: string,
    scheduleId: string
  ) => {
    try {
      const user = await User.findOne({ telegramId: userId });

      if (!user) {
        await bot.sendMessage(
          chatId,
          "❌ User not found. Please start with /start command."
        );
        return;
      }
      const result = await Schedule.deleteOne({
        _id: scheduleId,
        createdBy: user._id,
      });

      if (result.deletedCount > 0) {
        bot.sendMessage(chatId, "✅ Schedule deleted successfully.");
      } else {
        bot.sendMessage(chatId, "❌ Schedule not found or already completed.");
      }

      showMainMenu(chatId);
    } catch (error) {
      console.error("Error deleting schedule:", error);
      bot.sendMessage(chatId, "❌ Failed to delete schedule");
    }
  };
  bot.on("polling_error", (error) => {
    console.log(`Polling error: ${error.name}: ${error.message}`);
  });

  setInterval(()=>{

  },100000)

  process.on("SIGINT", () => {
    console.log("Shutting down await bot...");
    bot.stopPolling();
    mongoose.connection.close();
    process.exit(0);
  });
})();
