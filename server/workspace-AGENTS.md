# Agent Workspace & Delivery Specifications

## 1. Input vs Output Directory Isolation
To ensure clean structure and prevent accidental overwrite or input/output confusion, the workspace isolates files into two distinct folders:

| Directory | Default Path | Purpose |
| :--- | :--- | :--- |
| **User Input Zone** | `./uploads/` | Stores original user inputs, data tables, reference documents. |
| **AI Delivery Zone** | `./outputs/` | Stores final AI outputs (spreadsheets, reports, applications, archives). |

---

## 2. Delivery Rules
1. **Directly Openable Formats**: Output files in standard formats (Excel `.xlsx`, Word `.docx`, `.pdf`, `.html`, `.png`).
2. **Explicit Naming**: File names should contain full business identifiers (e.g. `[DocType]_[Project]_[Date]`).
3. **Delivery Checklist**:
   - [ ] Files saved to `./outputs/` directory
   - [ ] Formats and numbers verified
   - [ ] Minimal non-breaking modifications
