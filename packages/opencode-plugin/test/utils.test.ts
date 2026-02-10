import { describe, expect, test } from "bun:test"
import { serializeError } from "../src/utils"

describe("serializeError", () => {
  describe("Error instances", () => {
    test("should serialize Error with message, stack, and name", () => {
      const error = new Error("test error")
      const result = serializeError(error)

      expect(result).toEqual({
        message: "test error",
        name: "Error",
        stack: expect.stringContaining("test error"),
      })
    })

    test("should serialize TypeError", () => {
      const error = new TypeError("type mismatch")
      const result = serializeError(error)

      expect(result).toEqual({
        message: "type mismatch",
        name: "TypeError",
        stack: expect.stringContaining("type mismatch"),
      })
    })

    test("should serialize RangeError", () => {
      const error = new RangeError("out of range")
      const result = serializeError(error)

      expect(result).toEqual({
        message: "out of range",
        name: "RangeError",
        stack: expect.stringContaining("out of range"),
      })
    })

    test("should handle Error with empty message", () => {
      const error = new Error("")
      const result = serializeError(error)

      expect(result).toEqual({
        message: "",
        name: "Error",
        stack: expect.any(String),
      })
    })

    test("should include stack trace", () => {
      const error = new Error("with stack")
      const result = serializeError(error) as any

      expect(result.stack).toBeDefined()
      expect(result.stack).toContain("with stack")
    })
  })

  describe("non-Error values", () => {
    test("should return string as-is", () => {
      const result = serializeError("string error")
      expect(result).toBe("string error")
    })

    test("should return number as-is", () => {
      const result = serializeError(42)
      expect(result).toBe(42)
    })

    test("should return object as-is", () => {
      const obj = { code: "ERR_CUSTOM", details: "something" }
      const result = serializeError(obj)
      expect(result).toEqual(obj)
    })

    test("should return undefined as-is", () => {
      const result = serializeError(undefined)
      expect(result).toBeUndefined()
    })

    test("should return null as-is", () => {
      const result = serializeError(null)
      expect(result).toBeNull()
    })

    test("should return boolean as-is", () => {
      expect(serializeError(true)).toBe(true)
      expect(serializeError(false)).toBe(false)
    })

    test("should return array as-is", () => {
      const arr = [1, 2, 3]
      const result = serializeError(arr)
      expect(result).toEqual(arr)
    })
  })

  describe("JSON.stringify compatibility", () => {
    test("should produce valid JSON from serialized Error", () => {
      const error = new Error("test")
      const serialized = serializeError(error)
      const json = JSON.stringify(serialized)

      expect(json).toBeDefined()
      expect(() => JSON.parse(json)).not.toThrow()
    })

    test("should not produce empty object for Error", () => {
      const error = new Error("test")
      const serialized = serializeError(error)
      const json = JSON.stringify(serialized)

      expect(json).not.toBe("{}")
      expect(json).toContain("message")
      expect(json).toContain("test")
    })

    test("should preserve all Error properties in JSON", () => {
      const error = new Error("detailed error")
      const serialized = serializeError(error)
      const json = JSON.stringify(serialized)
      const parsed = JSON.parse(json)

      expect(parsed.message).toBe("detailed error")
      expect(parsed.name).toBe("Error")
      expect(parsed.stack).toBeDefined()
    })
  })
})
