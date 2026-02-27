import { describe, expect, test } from "bun:test"
import { serializeError, errorMessage } from "../src/utils"

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

})

describe("errorMessage", () => {
  test("returns message from Error instance", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom")
  })

  test("returns string as-is", () => {
    expect(errorMessage("something broke")).toBe("something broke")
  })

  test("returns message from plain { message } object", () => {
    expect(errorMessage({ message: "plain obj" })).toBe("plain obj")
  })

  // OpenCode NamedError variants: { name: string, data: { message?: string } }
  describe("OpenCode NamedError objects", () => {
    test("ContextOverflowError", () => {
      const err = {
        name: "ContextOverflowError",
        data: { message: "prompt is too long: 200210 tokens > 200000 maximum" },
      }
      expect(errorMessage(err)).toBe(
        "prompt is too long: 200210 tokens > 200000 maximum",
      )
    })

    test("APIError", () => {
      const err = {
        name: "APIError",
        data: {
          message: "rate limit exceeded",
          statusCode: 429,
          isRetryable: true,
        },
      }
      expect(errorMessage(err)).toBe("rate limit exceeded")
    })

    test("ProviderAuthError", () => {
      const err = {
        name: "ProviderAuthError",
        data: { providerID: "anthropic", message: "invalid API key" },
      }
      expect(errorMessage(err)).toBe("invalid API key")
    })

    test("UnknownError", () => {
      const err = { name: "UnknownError", data: { message: "something went wrong" } }
      expect(errorMessage(err)).toBe("something went wrong")
    })

    test("MessageAbortedError", () => {
      const err = {
        name: "MessageAbortedError",
        data: { message: "user cancelled" },
      }
      expect(errorMessage(err)).toBe("user cancelled")
    })

    test("MessageOutputLengthError (no data.message)", () => {
      const err = { name: "MessageOutputLengthError", data: {} }
      expect(errorMessage(err)).toBe("MessageOutputLengthError")
    })
  })

  describe("edge cases", () => {
    test("object with no message anywhere falls back to JSON", () => {
      const err = { code: 42, detail: "no message field" }
      expect(errorMessage(err)).toBe('{"code":42,"detail":"no message field"}')
    })

    test("null returns stringified null", () => {
      expect(errorMessage(null)).toBe("null")
    })

    test("undefined returns stringified undefined", () => {
      expect(errorMessage(undefined)).toBe("undefined")
    })

    test("number returns stringified number", () => {
      expect(errorMessage(500)).toBe("500")
    })
  })
})

// serializeError tests continued
describe("serializeError (continued)", () => {
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
