import type { BodyAssessmentWriteInput } from "./customers-health.types.js";

type Gender = "male" | "female" | "other";
type BodyType = "ectomorph" | "mesomorph" | "endomorph";
type DietType = "hipocalorica" | "normocalorica" | "hipercalorica";
type ActivityLevel = "sedentario" | "1_3_dias" | "3_5_dias" | "6_7_dias" | "2_veces_dia";

const activityFactor: Record<ActivityLevel, number> = {
  sedentario: 1.2,
  "1_3_dias": 1.375,
  "3_5_dias": 1.55,
  "6_7_dias": 1.725,
  "2_veces_dia": 1.9,
};
const dietFactor: Record<DietType, number> = {
  hipocalorica: 0.8,
  normocalorica: 1,
  hipercalorica: 1.2,
};
const bodyMacros: Record<BodyType, { protein: number; carbs: number; fats: number }> = {
  ectomorph: { protein: 0.3, carbs: 0.6, fats: 0.1 },
  mesomorph: { protein: 0.3, carbs: 0.4, fats: 0.3 },
  endomorph: { protein: 0.35, carbs: 0.3, fats: 0.35 },
};
const cardioMinutes: Record<BodyType, string> = {
  ectomorph: "10-15",
  mesomorph: "15",
  endomorph: "25-30",
};

function isKey<T extends object>(value: unknown, choices: T): value is keyof T {
  return typeof value === "string" && Object.hasOwn(choices, value);
}

function guatemalaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Guatemala", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

export function computeInitialNutrition(
  birthDate: string,
  gender: Gender,
  assessment: BodyAssessmentWriteInput,
) {
  const weightKg = assessment.weight_kg;
  const heightCm = assessment.height_cm;
  const bodyType = assessment.nutrition_snapshot?.body_type;
  const dietType = assessment.nutrition_snapshot?.diet_type;
  const activityLevel = assessment.nutrition_snapshot?.activity_level;
  if (!(typeof weightKg === "number" && typeof heightCm === "number") ||
      !isKey(bodyType, bodyMacros) || !isKey(dietType, dietFactor) ||
      !isKey(activityLevel, activityFactor)) return null;

  const [year, month, day] = birthDate.split("-").map(Number);
  const [todayYear, todayMonth, todayDay] = guatemalaToday().split("-").map(Number);
  const ageYears = Math.max(0, todayYear! - year! -
    (todayMonth! < month! || (todayMonth === month && todayDay! < day!) ? 1 : 0));
  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * ageYears +
    (gender === "female" ? -161 : gender === "other" ? -78 : 5);
  const dailyCalories = Math.round(bmr * activityFactor[activityLevel] * dietFactor[dietType]);
  const macros = bodyMacros[bodyType];

  return {
    gender,
    ageYears,
    heightCm,
    weightKg,
    bodyType,
    dietType,
    activityLevel,
    bodyFatPercentage: assessment.body_fat_percentage ?? null,
    muscleMassKg: assessment.muscle_mass_kg ?? null,
    chestCm: assessment.chest ?? null,
    waistCm: assessment.waist ?? null,
    armRightCm: assessment.arm_right ?? null,
    armLeftCm: assessment.arm_left ?? null,
    hipCm: assessment.hip ?? null,
    dailyCalories,
    proteinGrams: Math.round((dailyCalories * macros.protein) / 4),
    carbsGrams: Math.round((dailyCalories * macros.carbs) / 4),
    fatGrams: Math.round((dailyCalories * macros.fats) / 9),
    waterLitersGoal: Math.round((weightKg / 20) * 10) / 10,
    cardioMinutes: cardioMinutes[bodyType],
    routineMode: dietType === "hipocalorica" ? "definicion" : "volumen",
    algorithmVersion: "excel_2023_v1",
  };
}
