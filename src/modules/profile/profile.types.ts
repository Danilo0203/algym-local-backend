export type ProfileGender = "male" | "female" | "other";

export type ProfileResponse = {
  id: string;
  email: string | null;
  full_name: string;
  phone: string;
  birth_date: string;
  gender: ProfileGender;
  avatar_url: string | null;
  role: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type ProfileUpdateInput = {
  full_name?: string;
  phone?: string;
  birth_date?: string;
  gender?: ProfileGender;
};
