import VaultScreen from '../src/screens/VaultScreen';
import { useNavigation } from 'expo-router';

export default function Index() {
  const navigation = useNavigation();
  return <VaultScreen navigation={navigation} />;
}
