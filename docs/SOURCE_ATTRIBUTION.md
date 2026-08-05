# Source Attribution and Product Disclosure

## Upstream software

Virtual Lab Studio is an application layer built around:

- **Repository:** `zou-group/virtual-lab`
- **Project:** Virtual Lab
- **License:** MIT
- **Core concepts preserved:** prompt-defined agents, team meetings, individual expert–critic meetings, optional literature retrieval, and Markdown/JSON discussion records.

Keep the upstream `LICENSE` file and attribution in all derived distributions. Do not remove author notices from copied or modified files. Clearly distinguish upstream code from new application code in the project README and About/Methodology screen.

## Scientific work

The upstream repository accompanies work describing a human-guided LLM research team and a nanobody-design case study. The application may explain that lineage and link to the upstream publication, but must not imply that:

- every meeting is scientifically valid;
- multiple model roles are independent human experts;
- the app independently reproduces wet-lab validation;
- generated candidates are safe, effective, clinically validated, or approved;
- the web application itself is the published experimental system without qualification.

Use language such as:

> Virtual Lab Studio extends the open-source Virtual Lab meeting framework with a graphical research workspace, persistent evidence and projects, model/provider routing, provenance, review, and exports. Model-generated material requires qualified human review.

## Third-party services

The finished README must document optional services and their role:

- Replit Database: persistent application records.
- Replit App Storage: uploaded evidence and generated export objects.
- Replit Secrets: deployment secrets.
- Clerk or Replit Auth: authentication.
- OpenAI or an administrator-approved OpenAI-compatible endpoint: model inference.
- NCBI PubMed Central: optional biomedical literature retrieval.

Do not claim that a third-party service provides compliance, security, scientific validity, or data suitability merely because it is integrated. Administrators remain responsible for provider agreements, data classification, retention, access, and approved use.

## Display disclosure

Show a persistent, non-alarming disclosure in the application footer/About screen and in exported README files:

> Virtual Lab Studio supports human-guided research deliberation. Its agents are model-driven roles, not independent human experts. Outputs may contain errors and do not replace experimental validation, peer review, ethics review, clinical judgment, or other qualified professional oversight.
