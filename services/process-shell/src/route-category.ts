import { z } from "zod";

export const routeCategorySchema = z.enum(["scheduling", "referrals", "billing_or_insurance", "clinical", "records_or_administrative", "general_or_uncertain"]);
