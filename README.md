# 🛡️ SafePaste AI

> A VS Code extension that acts as a safety layer between AI-generated code and your codebase.

As developers increasingly rely on AI assistants like ChatGPT, Claude, and GitHub Copilot, code is often copied directly into projects without fully understanding its implications.

**SafePaste AI** helps developers make informed decisions **before** pasting AI-generated code by analyzing the snippet against the existing codebase and providing meaningful insights.

---

## ✨ Motivation

Copy-pasting AI-generated code has become a common part of software development.

However, developers often don't know:

- Does similar code already exist in my project?
- Am I introducing duplicate logic?
- Does this code violate my project's architecture?
- Is the pasted code safe to integrate?

SafePaste AI aims to answer these questions before the code becomes part of the repository.

---

## 🚀 Planned Features

### ✅ Repository Understanding
- Walk JavaScript/TypeScript repositories
- Parse source files using the TypeScript Compiler API
- Extract function-level code chunks

### 🔄 Semantic Duplicate Detection *(In Progress)*
- Embed repository functions
- Compare pasted code semantically
- Detect similar implementations even with different variable names

### 🛡️ Safety Analysis *(Planned)*
- Detect potentially unsafe patterns
- Highlight risky code before it is pasted

### 🏗️ Architecture Compatibility *(Planned)*
- Validate pasted code against project architecture
- Detect layer violations using configurable project rules

### 🤖 AI Explanation *(Planned)*
- Explain duplicate matches
- Summarize findings in natural language
- Help developers understand unfamiliar code before using it

---

## 🏛️ Architecture

```
                VS Code Extension
                        │
                        │
        TypeScript Compiler API
                        │
                Function Chunks
                        │
            JSON Lines (stdin/stdout)
                        │
               Python Worker Process
                        │
          Embeddings + Vector Search
                        │
              AI Explanation Layer
```

---

## 🧰 Tech Stack

### Extension
- TypeScript
- VS Code Extension API
- TypeScript Compiler API

### Backend
- Python

### AI / ML *(Upcoming)*
- Sentence Transformers
- ChromaDB
- Google Gemini API

---

## 📅 Current Progress

- ✅ Milestone 0 — Extension ↔ Python communication layer
- ✅ Milestone 1 — Repository traversal and AST-based function chunking
- 🚧 Milestone 2 — Embedding pipeline and vector indexing
- ⏳ Milestone 3 — Semantic duplicate detection
- ⏳ Milestone 4 — Safety analysis
- ⏳ Milestone 5 — AI explanations

---

## 📌 Why this project?

SafePaste AI is designed as a lightweight developer tool rather than another AI chatbot.

The goal is not to generate more code, but to help developers **understand, validate, and safely integrate AI-generated code into existing projects.**

---

## 📷 Demo

> Coming soon

---

## 🤝 Contributing

Contributions, suggestions, and feedback are welcome.

---

## 📄 License

MIT License
