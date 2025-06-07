import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

// Sanitize user input to prevent XSS
export function sanitizeInput(input: string): string {
  return input
    .trim()
    .replace(/[<>]/g, "") // Remove HTML brackets
    .substring(0, 1000); // Limit length
}

// UUID validation schema
export const uuidSchema = z.string().uuid();

// Game code validation
export const gameCodeSchema = z
  .string()
  .length(6)
  .regex(/^[A-Z0-9]{6}$/, "Invalid game code format");

// Pagination schemas
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Create a validation middleware factory
export function validateParams(schema: z.ZodSchema) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    try {
      request.params = schema.parse(request.params);
    } catch (error) {
      reply.code(400).send({
        error: "Invalid parameters",
        details: error instanceof z.ZodError ? error.errors : undefined,
      });
    }
  };
}

export function validateQuery(schema: z.ZodSchema) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    try {
      request.query = schema.parse(request.query);
    } catch (error) {
      reply.code(400).send({
        error: "Invalid query parameters",
        details: error instanceof z.ZodError ? error.errors : undefined,
      });
    }
  };
}
