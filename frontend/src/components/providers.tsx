"use client";

import { AuthProvider } from "@/contexts/AuthContext";
import { UserProfileProvider } from "@/contexts/UserProfileContext";
import { ThemeProvider } from "@/app/contexts/ThemeContext";

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <ThemeProvider>
            <AuthProvider>
                <UserProfileProvider>
                    {children}
                </UserProfileProvider>
            </AuthProvider>
        </ThemeProvider>
    );
}
