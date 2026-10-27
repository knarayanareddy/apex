export const DOCUMENT_INPUT_FORMATS = ["pdf", "docx", "pptx", "xlsx", "html", "md", "txt"] as const;
export type DocumentInputFormat = typeof DOCUMENT_INPUT_FORMATS[number];
export const DOCUMENT_OUTPUT_FORMATS = ["pdf", "docx", "pptx", "xlsx", "html", "md", "txt"] as const;
export type DocumentOutputFormat = typeof DOCUMENT_OUTPUT_FORMATS[number];

export interface DocumentLocator {
  page?: number;
  slide?: number;
  sheet?: string;
  row?: number;
  column?: number;
  block?: number;
  line?: number;
}
export interface DocumentSegment {
  kind: "heading" | "paragraph" | "cell" | "code" | "note" | "other";
  locator: DocumentLocator;
  text: string;
}
export interface DocumentExtraction {
  format: DocumentInputFormat;
  text: string;
  segments: DocumentSegment[];
  counts: { pages?: number; slides?: number; sheets?: number; cells?: number };
  warnings: string[];
  truncated: boolean;
  parserVersion: string;
}
export interface DocumentSectionSpec {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
  tables?: Array<{ columns: string[]; rows: string[][] }>;
}
export interface DocumentContentSpec {
  title: string;
  subtitle?: string;
  sections: DocumentSectionSpec[];
}
