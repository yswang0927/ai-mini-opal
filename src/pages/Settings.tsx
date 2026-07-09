import { useState, useEffect } from 'react';
import { api } from '@/utils/Api';

// 设置页面
export default function Settings() {
    const [settings, setSettings] = useState<any>({});

    const loadSettings = async () => {
        try {
            const config = await api.loadSettings();
            setSettings(config);
        } catch (e) {
            console.error('Failed to load settings:', e);
        }
    };

    const handleSaveSettings = async () => {
        try {
            await api.saveSettings(settings);
        } catch (e) {
            console.error('Failed to save settings:', e);
        }
    };

    return (
        <div></div>
    );
};