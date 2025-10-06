import mongoose from "mongoose";

export interface UserDocument extends Document {
  _id: mongoose.Types.ObjectId;
  telegramId: string;
  username?: string;
}

const userSchema = new mongoose.Schema<UserDocument>(
  {
    telegramId: {
      type: String,
      required: true,
      unique: true,
    },
    username: String,
  },

  {
    timestamps: true,
  }
);

const User = mongoose.model("User", userSchema);

export default User;
