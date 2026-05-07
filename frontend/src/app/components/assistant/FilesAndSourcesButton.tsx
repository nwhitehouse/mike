"use client";

import { useRef, useState } from "react";
import { PlusIcon, Upload, LayoutGridIcon, Loader2Icon } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { uploadStandaloneDocument } from "@/app/lib/mikeApi";
import type { MikeDocument } from "../shared/types";

// Sectioned source picker — extensible: new sections (Knowledge Base,
// Integrations, EU/UK Law, etc.) drop in here without restructuring.
const LEGAL_SOURCE_OPTIONS: { key: string; label: string }[] = [
    { key: "courtlistener", label: "Court Opinions" },
    { key: "govinfo", label: "Federal Legislation" },
    { key: "federal_register", label: "Federal Register" },
    { key: "ecfr", label: "Regulations (CFR)" },
];

interface Props {
    onSelectDoc: (doc: MikeDocument) => void;
    onBrowseAll: () => void;
    selectedDocIds?: string[];
    selectedLegalSources?: string[];
    onLegalSourcesChange?: (sources: string[]) => void;
}

export function FilesAndSourcesButton({
    onSelectDoc,
    onBrowseAll,
    selectedDocIds = [],
    selectedLegalSources = [],
    onLegalSourcesChange,
}: Props) {
    const [isOpen, setIsOpen] = useState(false);
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        setUploading(true);
        try {
            const uploaded = await Promise.all(
                files.map((f) => uploadStandaloneDocument(f)),
            );
            uploaded.forEach((doc) => onSelectDoc(doc));
        } catch (err) {
            console.error("Upload failed:", err);
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    const toggleLegalSource = (key: string) => {
        if (!onLegalSourcesChange) return;
        const isSelected = selectedLegalSources.includes(key);
        const next = isSelected
            ? selectedLegalSources.filter((s) => s !== key)
            : [...selectedLegalSources, key];
        onLegalSourcesChange(next);
    };

    const totalCount = selectedDocIds.length + selectedLegalSources.length;
    const hasSelection = totalCount > 0;

    return (
        <>
            <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.doc"
                multiple
                className="hidden"
                onChange={handleUpload}
            />
            <DropdownMenu onOpenChange={setIsOpen}>
                <DropdownMenuTrigger asChild>
                    <button
                        className={`flex items-center gap-1 px-2 h-8 rounded-lg text-sm transition-colors cursor-pointer ${
                            hasSelection
                                ? "text-foreground hover:bg-muted"
                                : "text-muted-foreground/70 hover:text-foreground hover:bg-muted"
                        } ${isOpen ? "bg-muted" : ""}`}
                        title="Files and sources"
                        aria-label="Files and sources"
                    >
                        {hasSelection ? (
                            <span className="font-medium tabular-nums">{totalCount}</span>
                        ) : (
                            <PlusIcon
                                className={`h-4 w-4 shrink-0 transition-transform duration-300 ${isOpen ? "rotate-[135deg]" : ""}`}
                            />
                        )}
                        <span className="hidden sm:inline">Files and sources</span>
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    className="w-56 z-50"
                    side="bottom"
                    align="start"
                >
                    <DropdownMenuItem
                        className="cursor-pointer"
                        disabled={uploading}
                        onSelect={(e) => {
                            e.preventDefault();
                            fileInputRef.current?.click();
                        }}
                    >
                        {uploading ? (
                            <Loader2Icon className="h-4 w-4 mr-2 animate-spin text-muted-foreground/70" />
                        ) : (
                            <Upload className="h-4 w-4 mr-2 text-muted-foreground" />
                        )}
                        <span className="text-sm">
                            {uploading ? "Uploading…" : "Upload files"}
                        </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        className="cursor-pointer"
                        onClick={onBrowseAll}
                    >
                        <LayoutGridIcon className="h-4 w-4 mr-2 text-muted-foreground" />
                        <span className="text-sm">Browse all</span>
                    </DropdownMenuItem>

                    {onLegalSourcesChange && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel className="text-xs text-muted-foreground font-normal uppercase tracking-wide">
                                US Legal Sources
                            </DropdownMenuLabel>
                            {LEGAL_SOURCE_OPTIONS.map((src) => (
                                <DropdownMenuCheckboxItem
                                    key={src.key}
                                    checked={selectedLegalSources.includes(src.key)}
                                    onCheckedChange={() => toggleLegalSource(src.key)}
                                    onSelect={(e) => e.preventDefault()}
                                    className="cursor-pointer"
                                >
                                    {src.label}
                                </DropdownMenuCheckboxItem>
                            ))}
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
        </>
    );
}
