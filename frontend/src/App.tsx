import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import HomePage from './pages/HomePage';
import GamesPage from './pages/GamesPage';
import GamePage from './pages/GamePage';
import ItemPage from './pages/ItemPage';
import OpportunitiesPage from './pages/OpportunitiesPage';
import DiagnosticsPage from './pages/DiagnosticsPage';

export default function App() {
	return (
		<Routes>
			<Route element={<Layout />}>
				<Route path="/" element={<HomePage />} />
				<Route path="/games" element={<GamesPage />} />
				<Route path="/games/:appid" element={<GamePage />} />
				<Route path="/items/:id" element={<ItemPage />} />
				<Route path="/opportunities" element={<OpportunitiesPage />} />
				<Route path="/diagnostics" element={<DiagnosticsPage />} />
				<Route path="*" element={<Navigate to="/" replace />} />
			</Route>
		</Routes>
	);
}
