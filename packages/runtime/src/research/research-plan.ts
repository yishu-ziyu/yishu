export interface ResearchPlanQuery {
  query: string;
  preference: "official" | "paper" | "news" | "documentation" | "community";
}

export interface ResearchPlan {
  question: string;
  queries: ResearchPlanQuery[];
}

export function buildResearchPlan(question: string, constraints?: string[]): ResearchPlan {
  const trimmed = question.replace(/\s+/gu, " ").trim();
  if (trimmed.length === 0) throw new Error("Research plan requires a question.");
  const extra = (constraints ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
  const queries: ResearchPlanQuery[] = [
    { query: trimmed, preference: "official" },
    { query: `${trimmed} official documentation`, preference: "documentation" },
  ];
  if (extra[0] !== undefined) {
    queries.push({ query: `${trimmed} ${extra[0]}`, preference: "news" });
  }
  if (queries.length < 3) {
    queries.push({ query: `${trimmed} primary source`, preference: "paper" });
  }
  return { question: trimmed, queries: queries.slice(0, 6) };
}
