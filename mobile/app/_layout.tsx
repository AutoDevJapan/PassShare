import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import api from '../src/services/api';
import LoginScreen from '../src/screens/LoginScreen';

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    const init = async () => {
      await api.init();
      setIsAuthenticated(api.isAuthenticated());
      setIsReady(true);
    };
    init();
  }, []);

  if (!isReady) {
    return null;
  }

  if (!isAuthenticated) {
    return (
      <>
        <StatusBar style="light" />
        <LoginScreen onLogin={() => setIsAuthenticated(true)} />
      </>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: {
            backgroundColor: '#0a0a0b',
          },
          headerTintColor: '#fff',
          contentStyle: {
            backgroundColor: '#0a0a0b',
          },
        }}
      >
        <Stack.Screen
          name="index"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="add"
          options={{
            title: 'Add Secret',
            presentation: 'modal',
          }}
        />
      </Stack>
    </>
  );
}
