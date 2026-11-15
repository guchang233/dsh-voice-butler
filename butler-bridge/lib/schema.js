import { z } from 'zod'

/** POST /voice/say */
export const sayBody = z.object({
  text: z.string().trim().min(1).max(8000)
})

/** POST /voice/approve */
export const approveBody = z.object({
  id: z.string().trim().min(1).max(80),
  allow: z.boolean()
})

/** POST /voice/persona */
export const personaBody = z.object({
  text: z.string().max(200_000)
})

/**
 * @typedef {z.infer<typeof sayBody>} SayBody
 * @typedef {z.infer<typeof approveBody>} ApproveBody
 * @typedef {z.infer<typeof personaBody>} PersonaBody
 */
