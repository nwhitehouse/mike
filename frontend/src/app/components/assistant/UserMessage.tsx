"use client";

import { File, FileText, Library } from "lucide-react";

interface Props {
    content: string;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
    /** Open the doc viewer side-panel for an attachment chip. Wired from
     *  ChatView; the chip is rendered as a button only when the file has
     *  a document_id and this handler is provided. Version is resolved
     *  to current at the viewer level (DocView accepts versionId=null). */
    onOpenDocument?: (args: { documentId: string; filename: string }) => void;
}

export function UserMessage({
    content,
    files,
    workflow,
    onOpenDocument,
}: Props) {
    const hasFiles = files && files.length > 0;

    return (
        <div className="w-full flex justify-end">
            <div className="max-w-[80%] bg-muted rounded-xl px-4 py-3">
                <p className="text-sm text-foreground whitespace-pre-wrap">{content}</p>
                {(workflow || hasFiles) && (
                    <div className="flex flex-wrap justify-end gap-1.5 mt-3">
                        {workflow && (
                            <div className="inline-flex items-center gap-1 pl-2 pr-2.5 py-0.5 rounded-full text-xs bg-blue-600 text-white shadow border border-blue-600">
                                <Library className="h-2.5 w-2.5 shrink-0" />
                                <span className="max-w-[140px] truncate">{workflow.title}</span>
                            </div>
                        )}
                        {hasFiles && files.map((f, i) => {
                            const ext = f.filename.split(".").pop()?.toLowerCase();
                            const isPdf = ext === "pdf";
                            const icon = isPdf
                                ? <FileText className="h-2.5 w-2.5 shrink-0 text-red-400" />
                                : <File className="h-2.5 w-2.5 shrink-0 text-blue-400" />;
                            const chipBase =
                                "inline-flex items-center gap-1 pl-2 pr-2.5 py-0.5 rounded-full text-xs text-primary-foreground shadow border border-black bg-primary";
                            const clickable = !!(onOpenDocument && f.document_id);
                            if (clickable) {
                                const docId = f.document_id as string;
                                return (
                                    <button
                                        key={i}
                                        type="button"
                                        onClick={() =>
                                            onOpenDocument?.({
                                                documentId: docId,
                                                filename: f.filename,
                                            })
                                        }
                                        className={`${chipBase} cursor-pointer hover:bg-foreground transition-colors`}
                                        title={`Open ${f.filename}`}
                                    >
                                        {icon}
                                        <span className="max-w-[140px] truncate">{f.filename}</span>
                                    </button>
                                );
                            }
                            return (
                                <div key={i} className={chipBase}>
                                    {icon}
                                    <span className="max-w-[140px] truncate">{f.filename}</span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
