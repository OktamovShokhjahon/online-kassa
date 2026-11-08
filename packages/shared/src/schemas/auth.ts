import { z } from 'zod';
import { languageSchema, passwordSchema } from './common';

export const loginBodySchema = z.object({
  login: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(128),
  language: languageSchema.optional(),
});

export const pinLoginBodySchema = z.object({
  terminalId: z.string().regex(/^[a-f\d]{24}$/i),
  login: z.string().trim().min(1).max(64),
  pin: z.string().regex(/^\d{4,6}$/),
});

export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export const languageBodySchema = z.object({ language: languageSchema });

export type LoginBody = z.infer<typeof loginBodySchema>;
